# Legal and ethical constraints

Not legal advice. This records the reasoning behind ClassG's design constraints so they don't
get relaxed later by someone who wasn't in the room.

## The bright line: receive only

**ClassG never transmits.** No jamming, no spoofing, no deauthentication, no takeover, no
"just a test beacon." This is enforced architecturally, not by policy:

- `sensor-wifi` uses **passive** monitor mode — no active monitor, no injection, no association
- `sensor-sdr` uses a receive-only device; the **bias tee stays disabled** by default
- No transmit-capable dependency is permitted in any service

### Why this line specifically

US federal law makes the distinction sharply:

- **47 U.S.C. § 333** — prohibits willfully or maliciously interfering with authorized radio
  communications. This maps directly onto what any jammer does.
- **47 U.S.C. § 302a** — prohibits non-federal entities from manufacturing, importing, selling,
  or using devices that don't comply with FCC rules, including intentional jammers.
- **18 U.S.C. § 32** — destroying or disabling an aircraft. Courts have treated drones as
  aircraft. Shooting one down, or forcing it down, is a felony.
- **Computer Fraud and Abuse Act / Pen-Trap / Wiretap Act** — implicated by *interception* and
  by unauthorized access to a drone's control link.

Authority to *mitigate* drones rests with a short list of federal agencies (DHS, DOJ, DoD, DOE)
under specific statutory authority. **It does not extend to private parties, local police,
critical-infrastructure operators, or hobbyists** — regardless of what a vendor claims.

Primary source: [Interagency Legal Advisory on UAS Detection and Mitigation Technologies](https://www.faa.gov/sites/faa.gov/files/uas/resources/c_uas/Interagency_Legal_Advisory_on_UAS_Detection_and_Mitigation_Technologies.pdf) (FAA/DOJ/DHS/FCC)

Passive, receive-only detection sits on the safe side of every one of these. Transmitting
anything at all moves the project across a line that is criminal, not merely regulatory.

## Detection is not unambiguously unregulated

The interagency advisory is careful here, and so should we be. Even passive systems can
implicate:

- **Wiretap Act (18 U.S.C. § 2511)** — intercepting the *contents* of communications.
  Remote ID broadcasts are explicitly designed for public reception and are readily accessible
  to the general public, which is the relevant safe-harbour concept. **Video downlink contents
  are a different matter entirely.**
- **Pen Register / Trap and Trace** — capturing dialing, routing, addressing, or signalling
  information.

### Design consequences, concretely

1. **Never demodulate video downlink content.** `sensor-sdr` performs **energy and cadence
   detection only** on FPV bands. It measures that a transmission exists and characterises its
   envelope. It must not recover video. This is a hard constraint on the DSP pipeline, not a
   feature that was skipped.
2. **Do not decode control-link payloads.** Detect the presence and cadence of ELRS/Crossfire
   bursts. Do not attempt to recover the packets.
3. **Remote ID and DJI DroneID payloads are fair game** — they are intentional public
   broadcasts whose entire purpose is identification.

## Operator location is the sharp edge

Both ASTM F3411 System messages and DJI DroneID `0x10` carry **the operator's GPS position**.
A working ClassG install produces a live map of where drone pilots are physically standing.

That is a real capability with real misuse potential, and "the protocol publishes it" is not
by itself a sufficient answer. Design responses:

- **Retention.** Operator positions default to short retention (see
  [data-model.md](../architecture/data-model.md#retention)). Long-term storage is opt-in and
  configured explicitly.
- **Separation.** Operator location is a distinct field in the schema, so it can be redacted or
  dropped at the API layer without touching the detection path.
- **Default off for export.** Any future TAK/MQTT/webhook export omits operator location unless
  explicitly enabled.
- **Don't build the aggregation.** No pilot-identity database, no cross-session tracking of
  individuals by serial, no correlation with external identity sources. Detection is about
  aircraft in your airspace, not about building dossiers on the people flying them.

## Privacy of your own capture

Monitor mode captures **all** 802.11 frames in range, not just drone beacons. Your neighbours'
networks and devices are in that capture. Accordingly:

- Filter as early as possible — ideally in the BPF filter, before frames reach userspace
- Store **only** frames matching drone criteria; discard the rest in the capture loop
- `captures/` is gitignored by default and must stay that way
- Treat any full-capture PCAP taken during debugging as sensitive, and delete it when done

## Jurisdiction

The above is US-centric. If deploying elsewhere:

- **EU** — ASD-STAN prEN 4709-002 is the Remote ID equivalent; GDPR applies to operator
  location, which is personal data. Retention defaults matter more, not less.
- **UK** — Wireless Telegraphy Act 2006 governs interception; the framing differs from the US.
- Receiving is more restricted in some jurisdictions than in the US. Check before deploying.

## Deployment posture

- **Fine:** monitoring airspace over property you control, research, education, understanding
  your own drone's emissions.
- **Think hard:** persistent monitoring in dense residential areas, where you will
  incidentally collect a great deal about neighbours who are not flying anything.
- **Don't:** anything involving transmission, anything targeting a specific individual,
  anything presented to a third party as a security service without understanding the
  liability you are assuming.
