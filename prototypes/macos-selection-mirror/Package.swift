// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Lesehilfe",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Lesehilfe", path: "Sources/Lesehilfe")
    ]
)
