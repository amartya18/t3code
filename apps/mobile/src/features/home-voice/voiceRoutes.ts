import { createNativeStackScreen } from "@react-navigation/native-stack";

import { modalRoute, sheetRoute } from "../layout/route-options";
import { VoiceCallScreen } from "./VoiceCallScreen";
import { VoiceSessionSheet } from "./VoiceSessionSheet";

/** Fork routes, spread into the root stack. */
export const HOME_VOICE_SCREENS = {
  VoiceCall: createNativeStackScreen({
    screen: VoiceCallScreen,
    linking: "voice",
    options: { ...modalRoute(), gestureEnabled: false },
  }),
  VoiceSessionSettings: createNativeStackScreen({
    screen: VoiceSessionSheet,
    options: sheetRoute({ detent: 0.75, androidMaxDetent: 0.95 }),
  }),
};
