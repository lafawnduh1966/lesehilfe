import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: SelectionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.isTrusted {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Accessibility access needed")
                        .font(.headline)
                    Text("Allow this app (or the Terminal you launched it from) in System Settings → Privacy & Security → Accessibility.")
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open Settings") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.15))
                .cornerRadius(8)
            }

            HStack {
                Text(model.sourceApp.isEmpty ? "No selection yet" : model.sourceApp)
                    .font(.caption.bold())
                Spacer()
                Text(model.method)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            ScrollView {
                Text(model.text.isEmpty ? "Select some text in any app…" : model.text)
                    .foregroundColor(model.text.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            HStack {
                Toggle("⌘C fallback", isOn: $model.clipboardFallback)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .help("If an app doesn't expose its selection, copy it via ⌘C after a mouse selection (clipboard is restored).")
                Spacer()
                Text("\(model.text.count) chars")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Button("Quit") { NSApp.terminate(nil) }
                    .controlSize(.small)
            }
        }
        .padding(12)
        .frame(minWidth: 280, minHeight: 180)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let model = SelectionModel()
    private lazy var watcher = SelectionWatcher(model: model)
    private var panel: NSPanel!

    func applicationDidFinishLaunching(_ notification: Notification) {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.title = "Lesehilfe"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: ContentView(model: model))
        panel.delegate = self

        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - 420, y: screen.maxY - 320))
        }
        panel.orderFrontRegardless()

        watcher.start()
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
