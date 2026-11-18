import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";
import * as HomeWatcher from "./HomeWatcher.ts";

/** Home and fleet services, shared by the WebSocket and MCP transports. */
export const HomeLayer = Layer.mergeAll(
  HomeWatcher.layer.pipe(Layer.provideMerge(HomeService.layer)),
  FleetService.layer.pipe(Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry)),
);
