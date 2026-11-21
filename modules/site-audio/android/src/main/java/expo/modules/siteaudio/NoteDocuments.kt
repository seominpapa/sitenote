package expo.modules.siteaudio

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File
import android.os.ParcelFileDescriptor
import java.security.MessageDigest
import java.util.UUID

internal object NoteDocuments {
  private const val ROOT = "Sitenote"
  private const val MARKER = ".sitenote-managed"
  private val MARKER_BYTES = "sitenote-managed-v1\n".toByteArray()
  private const val MAX_IMPORT_BYTES = 20L * 1024 * 1024

  fun label(resolver: ContentResolver, uri: Uri): String =
    query(resolver, treeDocument(uri), DocumentsContract.Document.COLUMN_DISPLAY_NAME) { getString(0) } ?: "선택한 폴더"

  fun import(resolver: ContentResolver, cache: File, uri: Uri): Map<String, String> {
    val name = NotePaths.name(query(resolver, uri, OpenableColumns.DISPLAY_NAME) { getString(0) }
      ?: throw IllegalArgumentException("선택한 파일 이름을 확인할 수 없습니다."))
    val declared = query(resolver, uri, OpenableColumns.SIZE) { if (isNull(0)) null else getLong(0) }
    require(declared == null || declared in 0..MAX_IMPORT_BYTES) { "파일은 20MB 이하여야 합니다." }
    val directory = File(cache, "note-imports").apply { mkdirs() }
    check(directory.isDirectory) { "가져온 파일을 저장하지 못했습니다." }
    val target = File(directory, "${UUID.randomUUID()}.${name.substringAfterLast('.')}")
    try {
      resolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "선택한 파일을 읽을 수 없습니다." }
        target.outputStream().use { output ->
          val buffer = ByteArray(32 * 1024)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= MAX_IMPORT_BYTES) { "파일은 20MB 이하여야 합니다." }
            output.write(buffer, 0, count)
          }
          output.flush()
        }
      }
      return mapOf("filename" to name, "cachePath" to Uri.fromFile(target).toString())
    } catch (error: Exception) {
      target.delete()
      throw error
    }
  }

  fun write(context: Context, tree: Uri, noteId: String, name: String, localPath: String, archive: Boolean): Uri {
    requireGrant(context.contentResolver, tree, write = true)
    val source = privateFile(context, localPath)
    require(source.isFile) { "저장할 파일을 찾을 수 없습니다." }
    val id = NotePaths.id(noteId)
    val safeName = NotePaths.name(name)
    val resolver = context.contentResolver
    val root = requireNotNull(managedRoot(resolver, tree))
    val branch = directory(resolver, tree, root, if (archive) "originals" else "notes")
    val note = directory(resolver, tree, branch, id)
    require(source.length() <= MAX_IMPORT_BYTES) { "파일은 20MB 이하여야 합니다." }
    val existing = child(resolver, tree, note, safeName)
    if (archive && existing != null) {
      require(sameContent(resolver, existing, source)) { "같은 이름의 원본 파일이 이미 있습니다." }
      return existing
    }
    if (existing == null) {
      val target = DocumentsContract.createDocument(resolver, note, "application/octet-stream", safeName)
        ?: throw IllegalStateException("노트 파일을 만들지 못했습니다.")
      try {
        require(displayName(resolver, target) == safeName) { "노트 파일 이름을 안전하게 만들지 못했습니다." }
        write(resolver, target, source)
      }
      catch (error: Exception) { runCatching { DocumentsContract.deleteDocument(resolver, target) }; throw error }
      return target
    }
    val token = UUID.randomUUID().toString()
    val staged = DocumentsContract.createDocument(resolver, note, "application/octet-stream", ".sitenote-$token.tmp")
      ?: throw IllegalStateException("노트 파일을 안전하게 저장하지 못했습니다.")
    try {
      write(resolver, staged, source)
      val backupName = ".sitenote-$token.bak"
      val backup = DocumentsContract.renameDocument(resolver, existing, backupName)
        ?: throw IllegalStateException("기존 노트 파일을 보존하지 못했습니다.")
      if (displayName(resolver, backup) != backupName) {
        runCatching { DocumentsContract.renameDocument(resolver, backup, safeName) }
        throw IllegalStateException("기존 노트 파일을 안전하게 보존하지 못했습니다.")
      }
      val replaced = try { DocumentsContract.renameDocument(resolver, staged, safeName) }
      catch (error: Exception) {
        runCatching { DocumentsContract.renameDocument(resolver, backup, safeName) }
        throw error
      }
      if (replaced == null || displayName(resolver, replaced) != safeName) {
        if (replaced != null) runCatching { DocumentsContract.deleteDocument(resolver, replaced) }
        runCatching { DocumentsContract.renameDocument(resolver, backup, safeName) }
        throw IllegalStateException("노트 파일을 교체하지 못했습니다.")
      }
      runCatching { DocumentsContract.deleteDocument(resolver, backup) }
      return replaced
    } catch (error: Exception) {
      runCatching { DocumentsContract.deleteDocument(resolver, staged) }
      throw error
    }
  }

  private fun write(resolver: ContentResolver, target: Uri, source: File) {
    val descriptor = requireNotNull(resolver.openFileDescriptor(target, "rwt")) { "노트 파일을 열지 못했습니다." }
    ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
      source.inputStream().use { it.copyTo(output, 32 * 1024) }
      output.flush()
      output.fd.sync()
    }
  }

  fun open(context: Context, tree: Uri, noteId: String, name: String, archive: Boolean) {
    requireGrant(context.contentResolver, tree, write = false)
    val resolver = context.contentResolver
    val root = managedRoot(resolver, tree, create = false)
    val branch = root?.let { child(resolver, tree, it, if (archive) "originals" else "notes") }
    val note = branch?.let { child(resolver, tree, it, NotePaths.id(noteId)) }
    val target = note?.let { child(resolver, tree, it, NotePaths.name(name)) }
      ?: throw IllegalArgumentException("노트 파일을 찾을 수 없습니다.")
    context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(target, mime(name))
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  fun deleteGenerated(context: Context, tree: Uri, noteId: String) {
    requireGrant(context.contentResolver, tree, write = true)
    val resolver = context.contentResolver
    val root = managedRoot(resolver, tree, create = false) ?: return
    val notes = child(resolver, tree, root, "notes") ?: return
    child(resolver, tree, notes, NotePaths.id(noteId))?.let { DocumentsContract.deleteDocument(resolver, it) }
  }

  private fun privateFile(context: Context, value: String): File {
    val uri = Uri.parse(value)
    require(uri.scheme == "file" && uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
      "앱 내부 파일만 저장할 수 있습니다."
    }
    val file = File(requireNotNull(uri.path)).canonicalFile
    val roots = listOf(context.filesDir, context.cacheDir).map(File::getCanonicalFile)
    require(roots.any { file.path.startsWith(it.path + File.separator) }) { "앱 내부 파일만 저장할 수 있습니다." }
    return file
  }

  private fun requireGrant(resolver: ContentResolver, tree: Uri, write: Boolean) {
    treeDocument(tree)
    require(tree.scheme == ContentResolver.SCHEME_CONTENT && resolver.persistedUriPermissions.any {
      it.uri == tree && it.isReadPermission && (!write || it.isWritePermission)
    }) { "선택한 폴더 권한이 없습니다. 폴더를 다시 선택해 주세요." }
  }

  private fun treeDocument(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(
    tree, DocumentsContract.getTreeDocumentId(tree)
  )

  private fun managedRoot(resolver: ContentResolver, tree: Uri, create: Boolean = true): Uri? {
    val parent = treeDocument(tree)
    val existing = child(resolver, tree, parent, ROOT)
    if (existing != null) {
      require(resolver.getType(existing) == DocumentsContract.Document.MIME_TYPE_DIR) { "Sitenote 이름의 파일이 이미 있습니다." }
      val marker = child(resolver, tree, existing, MARKER)
      require(marker != null && markerBytes(resolver, marker).contentEquals(MARKER_BYTES)) {
        "기존 Sitenote 폴더는 이 앱이 관리하는 폴더가 아닙니다. 다른 위치를 선택해 주세요."
      }
      return existing
    }
    if (!create) return null
    val root = DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, ROOT)
      ?: throw IllegalStateException("Sitenote 폴더를 만들지 못했습니다.")
    try {
      require(displayName(resolver, root) == ROOT) { "Sitenote 폴더 이름을 안전하게 만들지 못했습니다." }
      val marker = DocumentsContract.createDocument(resolver, root, "application/octet-stream", MARKER)
        ?: throw IllegalStateException("Sitenote 관리 표식을 만들지 못했습니다.")
      require(displayName(resolver, marker) == MARKER) { "Sitenote 관리 표식 이름을 확인하지 못했습니다." }
      writeBytes(resolver, marker, MARKER_BYTES)
      return root
    } catch (error: Exception) {
      runCatching { DocumentsContract.deleteDocument(resolver, root) }
      throw error
    }
  }

  private fun writeBytes(resolver: ContentResolver, target: Uri, bytes: ByteArray) {
    val descriptor = requireNotNull(resolver.openFileDescriptor(target, "rwt")) { "파일을 열지 못했습니다." }
    ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
      output.write(bytes)
      output.flush()
      output.fd.sync()
    }
  }

  private fun markerBytes(resolver: ContentResolver, uri: Uri): ByteArray =
    resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "Sitenote 관리 표식을 읽지 못했습니다." }
      val bytes = ByteArray(MARKER_BYTES.size + 1)
      var count = 0
      while (count < bytes.size) {
        val read = input.read(bytes, count, bytes.size - count)
        if (read < 0) break
        count += read
      }
      require(count <= MARKER_BYTES.size) { "올바른 Sitenote 관리 표식이 아닙니다." }
      bytes.copyOf(count)
    }

  private fun sameContent(resolver: ContentResolver, uri: Uri, source: File): Boolean {
    fun digest(read: ((ByteArray) -> Int)): ByteArray {
      val hash = MessageDigest.getInstance("SHA-256")
      val buffer = ByteArray(32 * 1024)
      var total = 0L
      while (true) {
        val count = read(buffer)
        if (count < 0) break
        total += count
        require(total <= MAX_IMPORT_BYTES) { "파일은 20MB 이하여야 합니다." }
        hash.update(buffer, 0, count)
      }
      return hash.digest()
    }
    val sourceHash = source.inputStream().use { digest(it::read) }
    val storedHash = resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "기존 원본 파일을 읽지 못했습니다." }
      digest(input::read)
    }
    return sourceHash.contentEquals(storedHash)
  }

  private fun directory(resolver: ContentResolver, tree: Uri, parent: Uri, name: String): Uri {
    val existing = child(resolver, tree, parent, name)
    if (existing != null) {
      require(resolver.getType(existing) == DocumentsContract.Document.MIME_TYPE_DIR) { "같은 이름의 파일이 이미 있습니다: $name" }
      return existing
    }
    val created = DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name)
      ?: throw IllegalStateException("폴더를 만들지 못했습니다: $name")
    if (displayName(resolver, created) != name) {
      runCatching { DocumentsContract.deleteDocument(resolver, created) }
      throw IllegalStateException("폴더 이름을 안전하게 만들지 못했습니다: $name")
    }
    return created
  }

  private fun child(resolver: ContentResolver, tree: Uri, parent: Uri, name: String): Uri? {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) if (cursor.getString(1) == name) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
      }
    }
    return null
  }

  private fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
    "md", "markdown", "txt" -> "text/plain"
    "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    "hwp" -> "application/x-hwp"
    "hwpx" -> "application/vnd.hancom.hwpx"
    else -> "application/octet-stream"
  }

  private fun <T> query(resolver: ContentResolver, uri: Uri, column: String, read: Cursor.() -> T): T? =
    resolver.query(uri, arrayOf(column), null, null, null)?.use { if (it.moveToFirst()) it.read() else null }

  private fun displayName(resolver: ContentResolver, uri: Uri): String? =
    query(resolver, uri, OpenableColumns.DISPLAY_NAME) { getString(0) }
}
