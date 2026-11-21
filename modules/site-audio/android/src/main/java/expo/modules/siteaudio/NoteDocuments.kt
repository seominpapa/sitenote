package expo.modules.siteaudio

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
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
  private const val MAX_TEXT_BYTES = 70L * 1024 * 1024

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

  fun publish(context: Context, tree: Uri, id: String, folder: String, transcript: String, summary: String?, imported: Boolean) {
    val resolver = context.contentResolver
    requireGrant(resolver, tree, write = true)
    NotePaths.id(id)
    NotePaths.folder(folder)
    require(summary == null || !imported) { "가져온 문서는 원문만 저장합니다." }
    val root = requireNotNull(managedRoot(resolver, tree))
    val notes = directory(resolver, tree, root, "notes")
    val originalsRoot = directory(resolver, tree, root, "originals")
    val originals = originalsRoot.takeIf { imported }
    val prefs = context.getSharedPreferences("sitenote-note-folders", Context.MODE_PRIVATE)
    val key = "$tree\n$id"
    val old = prefs.getString(key, null)
    val same = old?.substringBefore('\n') == folder
    val currentName = old?.substringAfter('\n')
    val current = currentName?.let { child(resolver, tree, notes, it) }
    val currentOriginal = if (originals == null || currentName == null) null else child(resolver, tree, originals, currentName)
    val oldFolderOwned = current != null && ownedFolder(resolver, prefs, "$key\nnotes", current)
    val oldArchiveOwned = currentOriginal != null && ownedFolder(resolver, prefs, "$key\noriginals", currentOriginal)
    if (same && current != null && oldFolderOwned &&
      (originals == null || oldArchiveOwned)) {
      val currentKey = "$key\n$currentName"
      write(resolver, tree, current, "transcript.md", transcript, prefs, "$currentKey\ntranscript.md")
      if (summary != null) write(resolver, tree, current, "summary.md", summary, prefs, "$currentKey\nsummary.md")
      if (currentOriginal != null) write(resolver, tree, currentOriginal, "original.txt", transcript, prefs, "$currentKey\noriginal.txt")
      return
    }
    val occupied = children(resolver, tree, notes).map { it.first }.toSet() +
      (originals?.let { children(resolver, tree, it).map { child -> child.first } } ?: emptyList())
    val name = (1..10_000).asSequence().map { NotePaths.candidate(folder, it) }.firstOrNull {
      it !in occupied
    } ?: throw IllegalStateException("사용 가능한 노트 폴더 이름을 찾지 못했습니다.")
    val note = createDirectory(resolver, notes, name)
    var archive: Uri? = null
    val nextKey = "$key\n$name"
    try {
      write(resolver, tree, note, "transcript.md", transcript, prefs, "$nextKey\ntranscript.md")
      if (summary != null) write(resolver, tree, note, "summary.md", summary, prefs, "$nextKey\nsummary.md")
      if (originals != null) {
        archive = createDirectory(resolver, originals, name)
        write(resolver, tree, archive, "original.txt", transcript, prefs, "$nextKey\noriginal.txt")
      }
      check(prefs.edit().putString(key, "$folder\n$name").putString("$key\nnotes", note.toString())
        .putString("$key\noriginals", archive?.toString()).commit()) { "노트 폴더 정보를 저장하지 못했습니다." }
    } catch (error: Exception) {
      runCatching { cleanupProjection(resolver, tree, note, prefs, nextKey, setOf("transcript.md", "summary.md")) }
      archive?.let { runCatching { cleanupProjection(resolver, tree, it, prefs, nextKey, setOf("original.txt")) } }
      throw error
    }
    if (currentName != null && current != null && oldFolderOwned) {
      cleanupProjection(resolver, tree, current, prefs, "$key\n$currentName", setOf("transcript.md", "summary.md"))
    }
    if (currentName != null && currentOriginal != null && oldArchiveOwned) {
      cleanupProjection(resolver, tree, currentOriginal, prefs, "$key\n$currentName", setOf("original.txt"))
    }
    // shortcut: leave legacy folders and externally edited files where they are.
  }

  private fun write(resolver: ContentResolver, tree: Uri, note: Uri, name: String, content: String, prefs: SharedPreferences, key: String) {
    val bytes = content.toByteArray(Charsets.UTF_8)
    require(bytes.size <= MAX_TEXT_BYTES) { "노트 파일 크기 한도를 넘었습니다." }
    val existing = child(resolver, tree, note, name)
    val desired = sha256(bytes)
    if (existing != null) {
      val before = prefs.getString(key, null)
      val actual = digest(resolver, existing)
      if (actual == desired) { if (before != desired) commitDigest(prefs, key, desired); return }
      require(actual != null && actual == before) { "다른 곳에서 수정한 파일은 덮어쓸 수 없습니다." }
    }
    if (existing == null) {
      val target = DocumentsContract.createDocument(resolver, note, "application/octet-stream", name)
        ?: throw IllegalStateException("노트 파일을 만들지 못했습니다.")
      try {
        require(displayName(resolver, target) == name) { "노트 파일 이름을 안전하게 만들지 못했습니다." }
        writeBytes(resolver, target, bytes)
        commitDigest(prefs, key, desired)
      }
      catch (error: Exception) { runCatching { DocumentsContract.deleteDocument(resolver, target) }; throw error }
      return
    }
    val token = UUID.randomUUID().toString()
    val staged = DocumentsContract.createDocument(resolver, note, "application/octet-stream", ".sitenote-$token.tmp")
      ?: throw IllegalStateException("노트 파일을 안전하게 저장하지 못했습니다.")
    try {
      writeBytes(resolver, staged, bytes)
      val backupName = ".sitenote-$token.bak"
      val backup = DocumentsContract.renameDocument(resolver, existing, backupName)
        ?: throw IllegalStateException("기존 노트 파일을 보존하지 못했습니다.")
      if (displayName(resolver, backup) != backupName) {
        runCatching { DocumentsContract.renameDocument(resolver, backup, name) }
        throw IllegalStateException("기존 노트 파일을 안전하게 보존하지 못했습니다.")
      }
      val replaced = try { DocumentsContract.renameDocument(resolver, staged, name) }
      catch (error: Exception) {
        runCatching { DocumentsContract.renameDocument(resolver, backup, name) }
        throw error
      }
      if (replaced == null || displayName(resolver, replaced) != name) {
        if (replaced != null) runCatching { DocumentsContract.deleteDocument(resolver, replaced) }
        runCatching { DocumentsContract.renameDocument(resolver, backup, name) }
        throw IllegalStateException("노트 파일을 교체하지 못했습니다.")
      }
      try { commitDigest(prefs, key, desired) }
      catch (error: Exception) {
        runCatching { DocumentsContract.deleteDocument(resolver, replaced) }
        runCatching { DocumentsContract.renameDocument(resolver, backup, name) }
        throw error
      }
      runCatching { DocumentsContract.deleteDocument(resolver, backup) }
    } catch (error: Exception) {
      runCatching { DocumentsContract.deleteDocument(resolver, staged) }
      throw error
    }
  }

  private fun ownedFolder(resolver: ContentResolver, prefs: SharedPreferences, key: String, folder: Uri) =
    prefs.getString(key, null) == folder.toString() && resolver.getType(folder) == DocumentsContract.Document.MIME_TYPE_DIR

  fun open(context: Context, uri: Uri, id: String, name: String) {
    require(uri.scheme == ContentResolver.SCHEME_CONTENT &&
      uri.authority == "${context.packageName}.FileSystemFileProvider" &&
      uri.pathSegments == listOf("expo_files", "note-originals", NotePaths.id(id), NotePaths.name(name))) {
      "앱에 보관된 원본 파일만 열 수 있습니다."
    }
    context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime(name))
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  fun openLegacy(context: Context, tree: Uri, noteId: String, name: String) {
    requireGrant(context.contentResolver, tree, write = false)
    val resolver = context.contentResolver
    val root = managedRoot(resolver, tree, create = false)
    val branch = root?.let { child(resolver, tree, it, "originals") }
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
    val prefs = context.getSharedPreferences("sitenote-note-folders", Context.MODE_PRIVATE)
    val key = "$tree\n${NotePaths.id(noteId)}"
    val name = prefs.getString(key, null)?.substringAfter('\n') ?: return
    val selected = child(resolver, tree, notes, name) ?: return
    if (ownedFolder(resolver, prefs, "$key\nnotes", selected)) {
      cleanupProjection(resolver, tree, selected, prefs, "$key\n$name", setOf("transcript.md", "summary.md"))
    }
  }

  private fun cleanupProjection(resolver: ContentResolver, tree: Uri, folder: Uri, prefs: SharedPreferences, key: String, knownFiles: Set<String>) {
    for ((name, uri) in children(resolver, tree, folder)) {
      if (name !in knownFiles || resolver.getType(uri) == DocumentsContract.Document.MIME_TYPE_DIR) continue
      val expected = prefs.getString("$key\n$name", null) ?: continue
      if (digest(resolver, uri) == expected) {
        check(DocumentsContract.deleteDocument(resolver, uri)) { "노트 파일을 지우지 못했습니다." }
        prefs.edit().remove("$key\n$name").apply()
      }
    }
    if (children(resolver, tree, folder).isEmpty()) DocumentsContract.deleteDocument(resolver, folder)
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

  private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).toHexString()

  private fun digest(resolver: ContentResolver, uri: Uri): String? = resolver.openInputStream(uri).use { input ->
    requireNotNull(input) { "기존 노트 파일을 읽지 못했습니다." }
    val hash = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(32 * 1024)
    var total = 0L
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      total += count
      if (total > MAX_TEXT_BYTES) return null
      hash.update(buffer, 0, count)
    }
    hash.digest().toHexString()
  }

  private fun commitDigest(prefs: SharedPreferences, key: String, digest: String) {
    check(prefs.edit().putString(key, digest).commit()) { "노트 파일 정보를 저장하지 못했습니다." }
  }

  private fun directory(resolver: ContentResolver, tree: Uri, parent: Uri, name: String): Uri {
    val existing = child(resolver, tree, parent, name)
    if (existing != null) {
      require(resolver.getType(existing) == DocumentsContract.Document.MIME_TYPE_DIR) { "같은 이름의 파일이 이미 있습니다: $name" }
      return existing
    }
    return createDirectory(resolver, parent, name)
  }

  private fun createDirectory(resolver: ContentResolver, parent: Uri, name: String): Uri {
    val created = DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name)
      ?: throw IllegalStateException("폴더를 만들지 못했습니다: $name")
    if (displayName(resolver, created) != name) {
      runCatching { DocumentsContract.deleteDocument(resolver, created) }
      throw IllegalStateException("폴더 이름을 안전하게 만들지 못했습니다: $name")
    }
    return created
  }

  private fun child(resolver: ContentResolver, tree: Uri, parent: Uri, name: String): Uri? =
    children(resolver, tree, parent).firstOrNull { it.first == name }?.second

  private fun children(resolver: ContentResolver, tree: Uri, parent: Uri): List<Pair<String, Uri>> = buildList {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        add(cursor.getString(1) to DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)))
      }
    }
  }

  private fun mime(name: String): String = when (name.substringAfterLast('.').lowercase()) {
    "md", "markdown", "txt" -> "text/plain"
    "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    "hwp" -> "application/x-hwp"
    "hwpx" -> "application/vnd.hancom.hwpx"
    "pdf" -> "application/pdf"
    else -> "application/octet-stream"
  }

  private fun <T> query(resolver: ContentResolver, uri: Uri, column: String, read: Cursor.() -> T): T? =
    resolver.query(uri, arrayOf(column), null, null, null)?.use { if (it.moveToFirst()) it.read() else null }

  private fun displayName(resolver: ContentResolver, uri: Uri): String? =
    query(resolver, uri, OpenableColumns.DISPLAY_NAME) { getString(0) }
}
