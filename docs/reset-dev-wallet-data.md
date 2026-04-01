# How to Fully Clear Wallet Data in Development

This guide is for `macOS` development environments for this repo. Use it when you want to start from a clean local wallet state, clear broken authorization data, remove leftover accounts or contacts, or remove old dApp trust state from the browser extension.

This reset removes local development wallet state. If an account only exists in local development storage and has not been backed up elsewhere, you should assume it will be lost.

## Before You Start

Before deleting anything, close all related processes:

- Quit the Electron wallet app.
- Close the Chrome window started by `yarn dev` / WXT.
- Close any local pages currently using the wallet, especially standalone wallet pages or iframe-based dApp flows.

If you want to double-check that nothing is still running, use a conservative process check first:

```bash
ps aux | rg "native-host|electron|AztecKeychain|demo-wallet"
```

The goal is to avoid deleting files while the wallet DB, PXE store, or native host socket is still open.

## Full Reset

### 1. Stop related processes

Make sure the wallet app and browser are no longer running. If the process check above still shows matching processes, stop them manually before continuing.

### 2. Remove local wallet data under `~/keychain`

The desktop wallet stores its local development data under `~/keychain`. That directory contains:

- wallet databases such as `wallet-<rollupAddress>`
- PXE data such as `pxe-<rollupAddress>`
- the IPC socket at `wallet.sock`
- debug logs such as `aztec-keychain-debug.log` and `native-host.log`

Remove it with:

```bash
rm -rf ~/keychain
```

This is the main reset for Electron-side wallet state.

### 3. Clear browser-side wallet storage

The web wallet also uses browser storage. Clearing `~/keychain` alone does not remove this layer.

Open Chrome DevTools for the relevant wallet page and any page you were using to test embedded iframe flows, then go to the `Application` tab and clear the following:

- `IndexedDB`
- `Cookies`
- optionally `Local Storage`

For cookies, explicitly remove these wallet entries if they exist:

- `aztec-wallet-accounts`
- `aztec-wallet-contacts-*`
- `aztec-wallet-caps-*`

Notes:

- These cookies are used to restore wallet state across standalone and iframe flows.
- `IndexedDB` is also used for browser-side wallet state and PXE-related data.
- `Local Storage` is not the main wallet secret store, but clearing it is still recommended for a cleaner reset. In particular, `aztec-keychain-selected-network` may preserve UI state you no longer want.

### 4. Clear trusted apps from the extension

The browser extension separately stores remembered dApps in `browser.storage.local`. If you skip this step, an old dApp can still look trusted even after other wallet data has been removed.

Use the extension UI as the primary cleanup path:

1. Open the extension popup.
2. Go to `Settings`.
3. Find the `Trusted Apps` section.
4. Click `Forget` for any entries you want to remove.

If you are still seeing auto-approved connections after that, also inspect the extension's storage in browser developer tools and clear the extension's local storage data as a secondary fallback.

### 5. Restart and verify

Restart the wallet app and the extension, then verify that:

- old accounts are no longer listed
- old contacts are no longer listed
- the wallet app's `Authorized Apps` section is empty
- dApps must request authorization again
- iframe-based flows no longer restore previous cookie-backed wallet state

If any of those still persist, you almost certainly missed one storage layer.

## Partial Cleanup Options

If you do not need a full wipe, use the smallest reset that matches the problem.

### Clear authorizations only

- Remove remembered dApps from the extension's `Settings` -> `Trusted Apps`
- Clear `aztec-wallet-caps-*` cookies
- If desktop-side authorizations still persist, remove `~/keychain`

### Clear accounts and contacts only

- Remove `~/keychain`
- Clear `aztec-wallet-accounts`
- Clear `aztec-wallet-contacts-*`

### Clear iframe-restored web state only

- Clear `IndexedDB`
- Clear the wallet cookies:
  - `aztec-wallet-accounts`
  - `aztec-wallet-contacts-*`
  - `aztec-wallet-caps-*`

## Troubleshooting

### I deleted app data, but the dApp still auto-connects

The most likely cause is that the extension still has the app stored in `Trusted Apps`. Remove it from the extension popup first.

### I cleared cookies, but old accounts still appear

The most likely cause is that desktop wallet data is still present under `~/keychain`.

### I removed `~/keychain`, but iframe state still comes back

The most likely cause is that wallet cookies or `IndexedDB` data still exist in the browser.
