import AppKit

final class SelectionModel: ObservableObject {
    @Published var text = ""
    @Published var sourceApp = ""
    @Published var method = ""
    @Published var isTrusted = SelectionReader.isTrusted
    @Published var clipboardFallback = false
}

/// Polls the frontmost app for its selection and, optionally, falls back to ⌘C after mouse selections.
final class SelectionWatcher {
    private let model: SelectionModel
    private var timer: Timer?
    private var mouseMonitors: [Any] = []
    private var mouseDownLocation: NSPoint = .zero

    init(model: SelectionModel) {
        self.model = model
    }

    func start() {
        if !SelectionReader.isTrusted {
            SelectionReader.requestTrust()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        let trusted = SelectionReader.isTrusted
        if model.isTrusted != trusted { model.isTrusted = trusted }
        guard trusted else { return }
        if mouseMonitors.isEmpty { installMouseMonitors() }

        guard let app = foreignFrontmostApp,
              let text = SelectionReader.accessibilitySelection(pid: app.processIdentifier)
        else { return }
        publish(text, from: app, method: "Accessibility")
    }

    // Global monitors only work once Accessibility access is granted.
    private func installMouseMonitors() {
        if let down = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown, handler: { [weak self] _ in
            self?.mouseDownLocation = NSEvent.mouseLocation
        }) {
            mouseMonitors.append(down)
        }
        if let up = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp, handler: { [weak self] event in
            self?.handleMouseUp(event)
        }) {
            mouseMonitors.append(up)
        }
    }

    private func handleMouseUp(_ event: NSEvent) {
        guard model.clipboardFallback else { return }
        let location = NSEvent.mouseLocation
        let dragged = hypot(location.x - mouseDownLocation.x, location.y - mouseDownLocation.y) > 5
        guard dragged || event.clickCount >= 2 else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self, let app = self.foreignFrontmostApp else { return }
            if SelectionReader.accessibilitySelection(pid: app.processIdentifier) != nil { return }
            SelectionReader.clipboardSelection { text in
                if let text, !text.isEmpty {
                    self.publish(text, from: app, method: "⌘C fallback")
                }
            }
        }
    }

    private var foreignFrontmostApp: NSRunningApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier
        else { return nil }
        return app
    }

    private func publish(_ text: String, from app: NSRunningApplication, method: String) {
        guard text != model.text else { return }
        model.text = text
        model.sourceApp = app.localizedName ?? app.bundleIdentifier ?? "Unknown app"
        model.method = method
    }
}
