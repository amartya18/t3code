import { PASSKEY_BRIDGE_ARGUMENT, PRIMARY_PASTE_DISABLED_ARGUMENT } from "./GuestProtocol.ts";

/** sandbox:true is required with contextIsolation:false or the shared page global would expose Node and IPC. */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";

/** Every page the preview hosts gets these, in a panel webview or in a tab's own window. */
export const hardenPreviewGuestPreferences = (
  webPreferences: Electron.WebPreferences,
  options: { readonly passkeyBridge: boolean; readonly primaryPaste: boolean },
): Electron.WebPreferences => {
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = false;
  webPreferences.additionalArguments = [
    ...(webPreferences.additionalArguments ?? []),
    ...(options.passkeyBridge ? [PASSKEY_BRIDGE_ARGUMENT] : []),
    ...(options.primaryPaste ? [] : [PRIMARY_PASTE_DISABLED_ARGUMENT]),
  ];
  return webPreferences;
};
