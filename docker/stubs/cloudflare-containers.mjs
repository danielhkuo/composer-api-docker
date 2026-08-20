/**
 * Stand-in for `@cloudflare/containers`, the single non-relative import in
 * upstream's entire worker/ tree.
 *
 * Upstream re-exports a `CursorSdkBridgeContainer extends Container` from
 * worker/index.ts. We never instantiate it -- this container reaches the SDK
 * bridge over plain HTTP via CURSOR_SDK_BRIDGE_URL instead of through a Durable
 * Object -- but the class declaration must still evaluate at import time.
 * A bare base class satisfies that, and keeps `cloudflare:workers` (which the
 * real package imports, and which does not exist off-Workers) out of the bundle.
 */
export class Container {}
export default { Container };
