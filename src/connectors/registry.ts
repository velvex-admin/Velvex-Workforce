// One place that knows which channel maps to which connector, and which of
// them are actually live.

import type { Env } from "../env.js";
import type { Channel } from "../core/types.js";
import { facebookConnector } from "./facebook.js";
import { xConnector } from "./x.js";
import { linkedInStatus } from "./linkedin.js";
import { ConnectorInactiveError, type Connector, type ConnectorStatus } from "./types.js";

const CONNECTORS: Partial<Record<Channel, Connector>> = {
  facebook: facebookConnector,
  x: xConnector,
};

export function getConnector(channel: Channel): Connector {
  const connector = CONNECTORS[channel];
  if (!connector) {
    // LinkedIn lands here on purpose: it is an external build reached through
    // the integration queue, not a connector we drive.
    throw new ConnectorInactiveError(channel, [`no connector is registered for "${channel}"`]);
  }
  return connector;
}

export function connectorStatuses(env: Env): ConnectorStatus[] {
  return [
    linkedInStatus(env),
    facebookConnector.status(env),
    xConnector.status(env),
  ];
}
