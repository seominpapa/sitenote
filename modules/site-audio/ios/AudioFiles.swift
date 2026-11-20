import Foundation

enum SiteAudioFiles {
  static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

  static func error(_ message: String) -> NSError {
    NSError(domain: "SiteAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static func resolve(_ uri: String, documents: URL, filePattern: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL, url.host?.isEmpty != false,
          url.query == nil, url.fragment == nil else {
      throw error("앱 내부 기록 경로만 사용할 수 있습니다.")
    }
    let parts = url.standardizedFileURL.pathComponents
    let root = documents.standardizedFileURL.pathComponents
    guard parts.count == root.count + 3, Array(parts.prefix(root.count)) == root,
          parts[root.count] == "records",
          parts[root.count + 1].range(of: #"\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z"#, options: .regularExpression) != nil,
          url.lastPathComponent.range(of: filePattern, options: .regularExpression) != nil else {
      throw error("올바른 기록 파일 경로가 아닙니다.")
    }
    let expected = documents.resolvingSymlinksInPath().appendingPathComponent("records")
      .appendingPathComponent(parts[root.count + 1])
    let parent = url.deletingLastPathComponent().resolvingSymlinksInPath()
    guard parent.path == expected.path,
          (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) == nil else {
      throw error("앱 내부 기록 경로만 사용할 수 있습니다.")
    }
    return url
  }

  static func writeText(_ uri: String, _ text: String, documents: URL = documents) throws {
    let file = try resolve(uri, documents: documents, filePattern: #"\A(?:transcript|summary)\.md\z"#)
    #if os(iOS)
    var records = documents.appendingPathComponent("records", isDirectory: true)
    if try records.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup != true {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try records.setResourceValues(values)
    }
    #endif
    try Data(text.utf8).write(to: file, options: .atomic)
  }
}

final class WaveArchive {
  private let file: FileHandle
  private var bytes: UInt32 = 0

  init(uri: String, documents: URL = SiteAudioFiles.documents) throws {
    let target = try SiteAudioFiles.resolve(uri, documents: documents, filePattern: #"\Aaudio-[A-Za-z0-9_-]{1,80}\.wav\z"#)
    try Self.header(0).write(to: target, options: .withoutOverwriting)
    file = try FileHandle(forWritingTo: target)
    try file.seekToEnd()
  }

  func append(_ pcm: Data) throws {
    guard UInt64(bytes) + UInt64(pcm.count) <= UInt64(UInt32.max) - 36 else {
      throw SiteAudioFiles.error("음성 원본 파일의 크기 한도에 도달했습니다.")
    }
    try file.write(contentsOf: pcm)
    bytes += UInt32(pcm.count)
  }

  func finish() throws {
    defer { try? file.close() }
    try file.seek(toOffset: 0)
    try file.write(contentsOf: Self.header(bytes))
    try file.synchronize()
  }

  private static func header(_ bytes: UInt32) -> Data {
    var data = Data()
    func put<T: FixedWidthInteger>(_ n: T) {
      var value = n.littleEndian
      withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
    }
    data.append(contentsOf: "RIFF".utf8); put(bytes + 36)
    data.append(contentsOf: "WAVEfmt ".utf8); put(UInt32(16))
    put(UInt16(1)); put(UInt16(1)); put(UInt32(24_000)); put(UInt32(48_000))
    put(UInt16(2)); put(UInt16(16))
    data.append(contentsOf: "data".utf8); put(bytes)
    return data
  }
}
