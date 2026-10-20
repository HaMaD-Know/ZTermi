import Capacitor
import UIKit

/// The app's root view controller: Capacitor's bridge view controller plus
/// registration of Terminia's in-app plugins. Plugins from npm packages are
/// discovered automatically; plugins compiled into the app target must be
/// registered here (https://capacitorjs.com/docs/ios/custom-code).
class TerminiaBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TerminiaFilesPlugin())
        bridge?.registerPluginInstance(TerminiaVaultPlugin())
        bridge?.registerPluginInstance(TerminiaHttpPlugin())
    }
}
