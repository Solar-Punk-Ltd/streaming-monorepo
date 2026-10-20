# Bee node mode and chain endpoint

This is a feature page of the manager (`apps/infra-manager`), the web console and API that deploys
the streaming stack (`apps/hls-stream`) onto hosts. It describes how a deployment's Bee node is
set to light or ultra-light, and where a light node's chain endpoint comes from.

## What it does

### Terms

- A **light** node talks to the Gnosis chain through an RPC endpoint, deploys a chequebook on its
  first start, needs xDAI for gas and BZZ for its chequebook and its postage, and can publish.
- An **ultra-light** node has no chain, no chequebook and no gas, and can only download. In Bee's
  own terms it is a node with no RPC endpoint that is not a full node.
- The **chain endpoint** (RPC endpoint) is the address a light node reaches the chain through.
  Its **source** is one of `manager` (the manager's own `BEE_RPC_ENDPOINT`), `stack` (the default
  the stack version carries) or `custom` (an address stored on the deployment).

### What the stack ships

The stack's compose file gives every publisher node, a stream's own node and each rung of an ABR
node pool, a chain endpoint from `RPC_ENDPOINT`, defaulting to the public
`https://rpc.gnosischain.com`, with SWAP on. That public endpoint rate limits, which is why the
manager offers its own first. The viewer gateway (`bee-gateway`) ships ultra-light: its endpoint
is `BEE_GATEWAY_RPC_ENDPOINT` and its SWAP switch `BEE_GATEWAY_SWAP_ENABLE`, empty and `false` by
default.

### What the manager stores

Two columns on a deployment:

- `node_mode` is `light`, `ultra-light` or empty. Empty means the mode the stack ships that node
  in: light for a deployment that runs a `bee-uploader`, ultra-light for one whose node is the
  viewer gateway (`effectiveNodeMode` in `common/src/nodeMode.ts`).
- `rpc_endpoint_source` is `manager`, `stack` or `custom`. The deployment's `rpc_endpoint` URL is
  set exactly when the source is `custom`.

The shared rules live in `common`:

- `nodeModeProblem` refuses an ultra-light `bee-uploader` with "an ultra-light node cannot
  upload".
- `rpcEndpointChoiceProblem` (`common/src/rpcEndpointSource.ts`) refuses `custom` without a valid
  URL, a URL with any other source, `manager` when the manager has no endpoint, and `stack` for a
  light gateway, because the stack's default for a gateway is no endpoint at all.

The mode is chosen when the deployment is created and cannot change after. An update carrying a
different mode is refused, because switching a node's mode changes what its data directory and
its chequebook mean.

### A custom endpoint stays private

A custom endpoint URL can carry a provider key, so it is private deployment input. A profile in
any answer, list, group result or `profile.changed` event carries only two derived fields:

- `has_rpc_endpoint`, whether a custom URL is stored.
- `rpc_endpoint_host`, its host. The projection in `PROFILE_COLUMNS`
  (`manager/src/domain/profileSql.ts`) reads a backslash as a path separator, the way the URL
  parser does, takes the authority after `http://` or `https://`, removes everything up to the
  last `@`, and answers null when nothing is left. So the host carries no user information, path,
  query or fragment.

The repository reads the full URL on its own (`rpcEndpointOf`) only to write a deployment's env
file and to redact the endpoint from output.

The edit drawer starts the custom endpoint field empty. Leaving it empty on an unchanged custom
choice sends no URL, and the manager keeps the stored one. Typing a replacement sends the
replacement. Choosing the manager's or the stack's source clears the stored URL, also when an API
client sends only the new source.

### The manager's own endpoint

`BEE_RPC_ENDPOINT` in the manager's environment is one optional URL, checked when the manager
starts. `GET /config` answers whether it is configured and its host, never the path or the user
information, because an endpoint that carries a key is a secret. The URL reaches a node only
through the deployment's env file, written with mode 600 (`ENV_FILE_MODE`), and is never logged.
A keyed endpoint belongs in the host's environment, set by whoever runs the host.

### What a deploy writes

When a deployment deploys, `writeProfileEnv` (`manager/src/utils/envUtils.ts`) resolves the
source:

- `manager` writes the manager's URL as `RPC_ENDPOINT`.
- `custom` writes the deployment's own URL as `RPC_ENDPOINT`.
- `stack` writes no line, so the stack's default applies.

For a deployment that runs the viewer gateway, it writes both gateway keys either way: the
endpoint and `BEE_GATEWAY_SWAP_ENABLE=true` for a light gateway, an empty endpoint and `false`
for an ultra-light one. The env file is a fresh copy of the host's base `.env` on every deploy, so
writing both modes keeps a host-wide value from deciding the gateway's chain.

## How to use it in the console

**New deployment wizard.** A stream's own node and a pool member show one line, "Light node,
required to publish", and the endpoint choice. The viewer gateway offers the mode, ultra-light by
default, and the endpoint choice when light is chosen. A custom deployment follows its ticked
components. The endpoint choice has three options:

- **Manager's endpoint**, with its host, shown and preselected only when the manager has one.
- **Stack default**, the public endpoint, which rate limits. Disabled for a light gateway.
- **Custom**, with a field for the URL.

The review step lists the mode and the endpoint.

**Deployment page.** The configuration card of any deployment that runs a Bee node names the mode,
"Light, on the chain" or "Ultra-light, download only", and the endpoint as its source and host,
or "None, an ultra-light node reaches no chain". The edit drawer offers the same three sources.
Going back to the stack's endpoint is a choice made there, not an emptied field. The mode is
read-only.

The readiness checklist shows funding and stamp steps only for a node that publishes, which is
always light, so an ultra-light gateway has neither.

## Settings and routes

Manager environment, full list in [../../manager/README.md](../../manager/README.md):

| Key                | Default | What it does                                                                              |
| ------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `BEE_RPC_ENDPOINT` | none    | The endpoint the `manager` source writes. A malformed value stops the manager at startup. |

Stack keys a deployment's env file carries:

| Key                        | Written when                                                              |
| -------------------------- | ------------------------------------------------------------------------- |
| `RPC_ENDPOINT`             | the source is `manager` or `custom`                                       |
| `BEE_GATEWAY_RPC_ENDPOINT` | the deployment runs the viewer gateway: the endpoint, or empty            |
| `BEE_GATEWAY_SWAP_ENABLE`  | the deployment runs the viewer gateway: `true` light, `false` ultra-light |

Profile fields, on `POST /profiles`, `PUT /profiles/:name` and `POST /groups`:

| Field                 | Values                       | Notes                                                                                      |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `node_mode`           | `light`, `ultra-light`, null | create only, an update may repeat it and not change it                                     |
| `rpc_endpoint_source` | `manager`, `stack`, `custom` | a create with none takes `manager` when one is configured, `stack` for an ultra-light node |
| `rpc_endpoint`        | an http(s) URL, or null      | only with `custom`, never returned                                                         |

Answers carry `has_rpc_endpoint` and `rpc_endpoint_host` in place of the URL. `GET /config`
answers `beeRpcEndpoint` as `{ configured, host }`. The full routes are in
[../../manager/README.md](../../manager/README.md).

## Limits

- The manager does not read the wallet or chequebook of a light viewer gateway. Fund it by hand.
- A Bee node prints its whole chain endpoint into its own container log on its host, which the
  manager cannot prevent. Prefer an endpoint that carries no key, such as a proxy on the host that
  holds it.
