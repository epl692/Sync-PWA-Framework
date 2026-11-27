# Hubs

A **Hub** is an Android or desktop app that people leave running in an area. Browser apps connect to it over Bluetooth, and it stores and forwards **encrypted** packets and blobs between everyone connected. It holds no content keys. See `specs/005-bluetooth-transport/`.

- `desktop/`: Electron shell (Windows, macOS, Linux) with a Bluetooth bridge per OS.
- `android/`: Capacitor shell with a Kotlin Bluetooth plugin and a foreground service.

These folders are built **outside the npm workspaces** because they need native toolchains (Gradle, Xcode, .NET) and heavy dependencies that must not enter the library dependency graph. All sync, access, and storage logic lives in `packages/hub-core` and `packages/hub-ui`; the native code only implements the `BleBridge` contract (`specs/005-bluetooth-transport/contracts/hub-ble-bridge.md`), and each bridge must pass `bleBridgeContract()` from `@sync/testkit`.
