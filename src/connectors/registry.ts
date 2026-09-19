// One place that knows which channel maps to which connector, and which of
// them are actually live.

import type { Env } from "../env.js";
import type { Channel } from "../core/types.js";
import { facebookConnector } from "./facebook.js";
import { xConnector } from "./x.js";
import { linkedInStatus } from "./linkedin.js";
import { linkedInDirectConnector } from "./linkedin-direct.js";
import { ConnectorInactiveError, type Connector, type ConnectorStatus } from "./types.js";

const CONNECTORS: Partial<Record<Channel, Connector>> = {
  facebook: facebookConnector,
  x: xConnector,
  // LinkedIn is registered now that we have a connector of our own. It refuses
  // until its credentials exist, and the strategist only reaches it when they
  // do — otherwise the draft goes to the partner queue, as it always has.
  linkedin: linkedInDirectConnector,
};

export function getConnector(channel: Channel): Connector {
  const connector = CONNECTORS[channel];
  if (!connector) {
    throw new ConnectorInactiveError(channel, [`no connector is registered for "${channel}"`]);
  }
  return connector;
}

export function connectorStatuses(env: Env): ConnectorStatus[] {
  // LinkedIn appears twice on purpose, because there are genuinely two routes
  // to that page and they can be live independently: the partner queue an
  // outside agent drains, and direct posting through our own connector. Their
  // notes say which is which. Collapsing them to one row would hide the fact
  // that a draft handed to the queue is not a draft that reached LinkedIn.
  return [
    linkedInStatus(env),
    linkedInDirectConnector.status(env),
    facebookConnector.status(env),
    xConnector.status(env),
  ];
}
