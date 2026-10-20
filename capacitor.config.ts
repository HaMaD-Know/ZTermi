import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

/**
 * Capacitor configuration for Terminia.
 *
 * The bundle identifier is a default. Change `appId` (and the matching
 * PRODUCT_BUNDLE_IDENTIFIER in ios/App/App.xcodeproj) to an identifier you own
 * before signing the app - see docs/SIGNING.md.
 */
const config: CapacitorConfig = {
  appId: 'com.terminia.app',
  appName: 'Terminia',
  webDir: 'dist',
  ios: {
    // Terminal output and the editor manage their own scrolling.
    scrollEnabled: false,
    contentInset: 'never',
    backgroundColor: '#0b0f17',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    Keyboard: {
      // "native" resizes the WKWebView itself, so the prompt and key bar stay above the keyboard.
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
