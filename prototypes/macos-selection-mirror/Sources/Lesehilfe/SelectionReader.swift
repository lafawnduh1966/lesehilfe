import AppKit
import ApplicationServices

/// Reads the currently selected text from other applications.
enum SelectionReader {
    private static var electronEnabledPIDs = Set<pid_t>()

    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func requestTrust() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /// Asks the Accessibility API for the selected text in the app's focused element.
    static func accessibilitySelection(pid: pid_t) -> String? {
        let app = AXUIElementCreateApplication(pid)

        // Electron apps only expose their accessibility tree when asked to.
        if !electronEnabledPIDs.contains(pid) {
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            electronEnabledPIDs.insert(pid)
        }

        guard let focused = copyAttribute(app, kAXFocusedUIElementAttribute) else { return nil }
        let element = focused as! AXUIElement

        if let text = copyAttribute(element, kAXSelectedTextAttribute) as? String, !text.isEmpty {
            return text
        }

        // Web content (WebKit, Chromium) often only exposes selections via text markers.
        if let range = copyAttribute(element, "AXSelectedTextMarkerRange") {
            var value: CFTypeRef?
            let err = AXUIElementCopyParameterizedAttributeValue(
                element, "AXStringForTextMarkerRange" as CFString, range, &value)
            if err == .success, let text = value as? String, !text.isEmpty {
                return text
            }
        }
        return nil
    }

    /// Fallback: sends ⌘C to the frontmost app, reads the clipboard, then restores it.
    static func clipboardSelection(completion: @escaping (String?) -> Void) {
        let pasteboard = NSPasteboard.general
        let saved = pasteboard.pasteboardItems?.map { item in
            item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { dict, type in
                dict[type] = item.data(forType: type)
            }
        } ?? []
        let changeCountBefore = pasteboard.changeCount

        let source = CGEventSource(stateID: .combinedSessionState)
        let cKey: CGKeyCode = 8
        for keyDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: cKey, keyDown: keyDown)
            event?.flags = .maskCommand
            event?.post(tap: .cghidEventTap)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard pasteboard.changeCount != changeCountBefore else {
                completion(nil)
                return
            }
            let text = pasteboard.string(forType: .string)

            pasteboard.clearContents()
            if !saved.isEmpty {
                pasteboard.writeObjects(saved.map { dict in
                    let item = NSPasteboardItem()
                    for (type, data) in dict { item.setData(data, forType: type) }
                    return item
                })
            }
            completion(text)
        }
    }

    private static func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value
    }
}
