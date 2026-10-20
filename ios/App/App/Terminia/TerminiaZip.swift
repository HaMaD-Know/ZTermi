import Compression
import CryptoKit
import Foundation

/// One entry of a zip archive's central directory.
struct TerminiaZipEntry {
    let name: String
    let method: UInt16
    let compressedSize: UInt64
    let size: UInt64
    let localHeaderOffset: UInt64
}

/// Minimal, streaming zip reader for build artifacts: lists the central
/// directory (zip64 included) and extracts one entry (stored or deflate)
/// straight to disk, so large IPAs never pass through JavaScript.
final class TerminiaZipReader {
    private let handle: FileHandle
    private let fileSize: UInt64
    private static let chunk = 1 << 20

    init(url: URL) throws {
        handle = try FileHandle(forReadingFrom: url)
        fileSize = try handle.seekToEnd()
    }

    deinit {
        try? handle.close()
    }

    private func read(at offset: UInt64, count: Int) throws -> [UInt8] {
        try handle.seek(toOffset: offset)
        guard let data = try handle.read(upToCount: count), data.count == count else {
            throw TerminiaFileError.code("VALIDATION", "The zip archive ended unexpectedly.")
        }
        return [UInt8](data)
    }

    private func u16(_ b: [UInt8], _ i: Int) -> UInt64 {
        UInt64(b[i]) | UInt64(b[i + 1]) << 8
    }

    private func u32(_ b: [UInt8], _ i: Int) -> UInt64 {
        u16(b, i) | u16(b, i + 2) << 16
    }

    private func u64(_ b: [UInt8], _ i: Int) -> UInt64 {
        u32(b, i) | u32(b, i + 4) << 32
    }

    func entries() throws -> [TerminiaZipEntry] {
        guard fileSize >= 22 else { throw TerminiaFileError.code("VALIDATION", "Not a zip archive.") }
        let tailLength = Int(min(fileSize, 65_557))
        let tail = try read(at: fileSize - UInt64(tailLength), count: tailLength)
        var eocd = -1
        var i = tail.count - 22
        while i >= 0 {
            if tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06 {
                eocd = i
                break
            }
            i -= 1
        }
        guard eocd >= 0 else { throw TerminiaFileError.code("VALIDATION", "Not a zip archive.") }
        var count = u16(tail, eocd + 10)
        var cdSize = u32(tail, eocd + 12)
        var cdOffset = u32(tail, eocd + 16)
        if count == 0xFFFF || cdSize == 0xFFFF_FFFF || cdOffset == 0xFFFF_FFFF {
            let locator = eocd - 20
            guard locator >= 0, u32(tail, locator) == 0x0706_4b50 else {
                throw TerminiaFileError.code("VALIDATION", "Damaged zip64 archive.")
            }
            let record = try read(at: u64(tail, locator + 8), count: 56)
            guard u32(record, 0) == 0x0606_4b50 else { throw TerminiaFileError.code("VALIDATION", "Damaged zip64 archive.") }
            count = u64(record, 32)
            cdSize = u64(record, 40)
            cdOffset = u64(record, 48)
        }
        guard cdSize <= 64 * 1024 * 1024, cdOffset + cdSize <= fileSize else {
            throw TerminiaFileError.code("VALIDATION", "The zip directory is damaged or too large.")
        }
        let cd = try read(at: cdOffset, count: Int(cdSize))
        var entries: [TerminiaZipEntry] = []
        var p = 0
        while entries.count < Int(min(count, 100_000)) && p + 46 <= cd.count {
            guard u32(cd, p) == 0x0201_4b50 else { break }
            let flags = u16(cd, p + 8)
            let method = UInt16(u16(cd, p + 10))
            var compressed = u32(cd, p + 20)
            var size = u32(cd, p + 24)
            let nameLength = Int(u16(cd, p + 28))
            let extraLength = Int(u16(cd, p + 30))
            let commentLength = Int(u16(cd, p + 32))
            var offset = u32(cd, p + 42)
            guard p + 46 + nameLength + extraLength <= cd.count else { break }
            let nameBytes = Array(cd[(p + 46)..<(p + 46 + nameLength)])
            let name = (flags & 0x800) != 0
                ? String(decoding: nameBytes, as: UTF8.self)
                : (String(bytes: nameBytes, encoding: .utf8) ?? String(bytes: nameBytes, encoding: .isoLatin1) ?? "")
            var e = p + 46 + nameLength
            let extraEnd = e + extraLength
            while e + 4 <= extraEnd {
                let id = u16(cd, e)
                let length = Int(u16(cd, e + 2))
                if id == 0x0001 {
                    var q = e + 4
                    if size == 0xFFFF_FFFF, q + 8 <= extraEnd { size = u64(cd, q); q += 8 }
                    if compressed == 0xFFFF_FFFF, q + 8 <= extraEnd { compressed = u64(cd, q); q += 8 }
                    if offset == 0xFFFF_FFFF, q + 8 <= extraEnd { offset = u64(cd, q) }
                }
                e += 4 + length
            }
            entries.append(TerminiaZipEntry(name: name, method: method, compressedSize: compressed, size: size, localHeaderOffset: offset))
            p += 46 + nameLength + extraLength + commentLength
        }
        return entries
    }

    /// Writes one entry to `destination`, verifying the uncompressed size.
    func extract(_ entry: TerminiaZipEntry, to destination: URL) throws -> UInt64 {
        let local = try read(at: entry.localHeaderOffset, count: 30)
        guard u32(local, 0) == 0x0403_4b50 else { throw TerminiaFileError.code("VALIDATION", "Damaged zip entry '\(entry.name)'.") }
        let dataStart = entry.localHeaderOffset + 30 + u16(local, 26) + u16(local, 28)
        guard dataStart + entry.compressedSize <= fileSize else { throw TerminiaFileError.code("VALIDATION", "Damaged zip entry '\(entry.name)'.") }

        let fm = FileManager.default
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
        guard fm.createFile(atPath: destination.path, contents: nil) else {
            throw TerminiaFileError.code("IO_ERROR", "Could not create \(destination.lastPathComponent).")
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        var written: UInt64 = 0
        var remaining = entry.compressedSize
        try handle.seek(toOffset: dataStart)
        switch entry.method {
        case 0:
            while remaining > 0 {
                let n = Int(min(UInt64(Self.chunk), remaining))
                guard let data = try handle.read(upToCount: n), !data.isEmpty else { break }
                try output.write(contentsOf: data)
                written += UInt64(data.count)
                remaining -= UInt64(data.count)
            }
        case 8:
            // Apple's .zlib algorithm is raw DEFLATE (RFC 1951), which is what zip uses.
            let filter = try OutputFilter(.decompress, using: .zlib) { (data: Data?) in
                if let data = data, !data.isEmpty {
                    try output.write(contentsOf: data)
                    written += UInt64(data.count)
                }
            }
            while remaining > 0 {
                let n = Int(min(UInt64(Self.chunk), remaining))
                guard let data = try handle.read(upToCount: n), !data.isEmpty else { break }
                try filter.write(data)
                remaining -= UInt64(data.count)
            }
            try filter.finalize()
        default:
            throw TerminiaFileError.code("UNSUPPORTED", "Zip compression method \(entry.method) is not supported.")
        }
        guard written == entry.size else {
            throw TerminiaFileError.code("VALIDATION", "'\(entry.name)' did not extract completely (\(written) of \(entry.size) bytes).")
        }
        return written
    }
}

/// Streaming SHA-256 of a file (hex).
func terminiaSHA256(of url: URL) throws -> (String, UInt64) {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    var size: UInt64 = 0
    while let data = try handle.read(upToCount: 1 << 20), !data.isEmpty {
        hasher.update(data: data)
        size += UInt64(data.count)
    }
    let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return (hex, size)
}
