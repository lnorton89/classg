# Where the API deviates from the contract, and why

[api-contract.md](api-contract.md) is normative. This file is the short list of
places the implementation knowingly does something the contract does not
describe — each one deliberate, each one flagged in the code with a pointer
here.

Three comments in the API pointed at this file for some time before it existed,
which meant the deviations they flagged were recorded nowhere at all. That is
the gap this closes.

## `/health` carries a `fusion` block the contract does not define

`health.FusionLink` reports whether the API is actually receiving from fusion:
`configured`, `connected`, `last_message`, `reason`.

**Why.** The contract's own stated purpose for `/health` — telling a quiet sky
from a broken detector — is not served by sensor health alone. Every sensor can
heartbeat happily while the track pipeline is dead, and the resulting empty map
looks exactly like nothing flying. `sensor_kind` is a closed enum of
`wifi|sdr|ble|net`, so fusion cannot be reported as a sensor and needed its own
field.

**Status.** Additive. A consumer that ignores it sees exactly the contract's
shape. Fold into the contract when it is next revised.

Code: `services/api/internal/health/health.go`.

## `DecodeTrack` accepts `evidence` as either an array or an object

`track.schema.json` declares `evidence` as an array. The decoder also accepts an
object keyed by detection class.

**Why.** Fusion's in-memory `Track` holds `EvidenceMap`, a map keyed by class,
and naive marshalling would publish an object. Twenty lines of tolerance avoided
a silent field loss if that ever shipped.

**Status.** Now belt-and-braces rather than load-bearing. Fusion has a custom
`EvidenceMap.MarshalJSON` that emits the sorted array, and two tests pin it:
`TestTrackMarshalsEvidenceAsSchemaArray` and, against the schema itself,
`TestPublishedTrackSatisfiesTheSchema`. The tolerance is kept because the cost
is low and the failure it prevents is silent, but it is no longer covering an
actual divergence.

Code: `services/api/internal/model/model.go`.

## A track's detections are reconstructed, not recorded

`GET /tracks/{id}/detections` and the GraphQL `detections` field on a track
return detections matched by the track's identity within its lifetime.

**Why.** Nothing on the bus carries the association. Fusion publishes tracks and
sensors publish detections; the link between them exists only inside fusion's
correlator and is never emitted. Matching on identity within the lifetime is the
closest honest answer available.

**Status.** A reconstruction, and the API says so in the field's own
description rather than implying a recorded fact. Closing it properly means
fusion emitting the detection ids that fed each track, which is a schema change.

Note that `track.receivers[]` is *not* this link: it records which receiver
contributed and when, not which detections.

Code: `services/api/internal/store/store.go`.
