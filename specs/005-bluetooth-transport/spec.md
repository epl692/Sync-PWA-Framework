# Feature Specification: Bluetooth Local Transport

**Feature Branch**: `005-bluetooth-transport`

**Created**: 2026-11-27

**Status**: Draft

**Input**: User description: "Build a transport plugin that uses Bluetooth to sync and communicate locally between clients to support offline usage."

This spec adds a Bluetooth transport plugin implementing the Transport contract from spec 001. It lets nearby devices exchange Data Packets (and blobs, per spec 004) with no internet, no server, and no shared Wi-Fi. It builds on the Transport contract (001), Space membership and signing (002), module registration (003), and blob transfer (004). It changes none of them.

## Clarifications

### Session 2026-11-27

- Q: Where must the Bluetooth transport work? → A: [NEEDS CLARIFICATION: Browsers can only act as Bluetooth clients, so two browser-only PWAs cannot connect directly. Spec 001 dropped Bluetooth from v1 for this reason. Which runtime scope applies?]

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sync Two Nearby Devices With No Network (Priority: P1)

A user with an app built on the Framework is in a place with no internet (a field, a basement, a flight). They open the app on their phone, and a colleague opens it on theirs. Each user chooses to connect over Bluetooth, the devices find each other, and changes made on either device appear on the other.

**Why this priority**: This is the whole point of the feature: working collaboration when there is no network at all.

**Independent Test**: Put two devices in airplane mode with Bluetooth on, create objects on each, connect them, and verify both devices converge to the same state.

**Acceptance Scenarios**:

1. **Given** two devices in the same Space with no internet, **When** the users connect them over Bluetooth, **Then** all packets one device has and the other lacks are exchanged until both hold the same state.
2. **Given** two connected devices, **When** a user edits an object, **Then** the change appears on the other device within a few seconds with no user action.
3. **Given** two devices that have never met, **When** they connect, **Then** neither user needs to enter an address, code, or account information beyond an on-screen confirmation.
4. **Given** a connection is established, **When** the app is also connected to another transport, **Then** both run simultaneously and packets are deduplicated by ID.

---

### User Story 2 - Discover and Choose Nearby Peers Safely (Priority: P1)

A user opens the Bluetooth connection screen and sees nearby devices running the same app. They connect only to devices that belong to a Space they share, and are never exposed to data from Spaces they are not in.

**Why this priority**: A local radio transport is reachable by strangers. Without safe discovery and trust, the feature is a data-leak risk.

**Independent Test**: Place three devices nearby, two sharing a Space and one outside it. Verify the outsider cannot read any packets or learn Space contents, and the user can tell the devices apart.

**Acceptance Scenarios**:

1. **Given** several nearby devices running the app, **When** the user opens the connection screen, **Then** they see a list of discoverable peers with a human-readable name and which shared Spaces apply.
2. **Given** a nearby device that shares no Space with the user, **When** it attempts to connect, **Then** it receives no packets and no Space content, and the attempt is rejected.
3. **Given** a connection request from an unknown device, **When** the user has not approved it, **Then** nothing is exchanged until the user confirms.
4. **Given** a peer sends a packet with an invalid signature or from an author without a role in the Space, **When** it arrives over Bluetooth, **Then** it is rejected exactly as on any other transport.

---

### User Story 3 - Resume and Survive Dropouts (Priority: P2)

Two devices are syncing and one user walks out of range or the screen locks. When they come back together, sync resumes by exchanging only what is missing, without duplicating or corrupting data.

**Why this priority**: Bluetooth links are short-range and unstable; graceful recovery is what makes the transport usable in practice.

**Independent Test**: Start a large sync, interrupt the connection midway, reconnect, and verify the final state is correct and that previously received packets are not re-sent.

**Acceptance Scenarios**:

1. **Given** a sync interrupted halfway, **When** the devices reconnect, **Then** only the missing packets are exchanged.
2. **Given** a peer that previously connected and is now back in range, **When** reconnection is enabled for it, **Then** the devices reconnect without re-pairing.
3. **Given** the connection drops while a packet is half-sent, **When** the sync resumes, **Then** the partial packet is discarded and re-requested without affecting other packets.

---

### User Story 4 - Relay Through Intermediate Devices (Priority: P2)

Three people are in a row: A can reach B, B can reach C, but A cannot reach C. A edits an object; B receives it and C receives it through B.

**Why this priority**: Real local groups rarely have full connectivity. Multi-hop relay makes a small cluster act as one group, consistent with the Framework's relay rules.

**Independent Test**: Connect A–B and B–C only. Write on A, and verify C converges without a direct A–C link and without relay loops.

**Acceptance Scenarios**:

1. **Given** A–B and B–C connected with relay enabled, **When** A writes, **Then** C eventually receives the packet.
2. **Given** a cluster of devices, **When** packets are relayed, **Then** no packet is applied twice or looped indefinitely.
3. **Given** a device connected to both Bluetooth and an internet transport, **When** packets arrive on one, **Then** they can be relayed to the other, subject to the per-app and per-Space relay settings.

---

### User Story 5 - Sync Larger Content Locally (Priority: P3)

Users nearby also want to share photos or files attached to objects. Blobs transfer over the Bluetooth link, slowly but reliably, with visible progress and the ability to continue later.

**Why this priority**: Valuable, but text and structured objects are the core need; the link's speed limits how much it can carry.

**Independent Test**: Attach a blob to an object on device A, connect to device B over Bluetooth, and verify the blob arrives intact with progress shown, and resumes after an interruption.

**Acceptance Scenarios**:

1. **Given** a blob attached to a synced object, **When** a peer connects, **Then** the blob transfers using the blob rules from spec 004 and is verified on arrival.
2. **Given** a blob transfer in progress, **When** the user views the app, **Then** progress is visible and normal packet sync is not starved by the transfer.
3. **Given** a blob too large to transfer practically over Bluetooth, **When** a peer connects, **Then** the user is told it will wait for a faster transport rather than failing silently.

---

### Edge Cases

- Bluetooth is turned off, permission is denied, or the device has no Bluetooth: the transport reports itself unsupported or unavailable and the app continues on other transports or fully offline.
- Many devices are nearby: the number of simultaneous connections is limited, and the user is told when a limit prevents another connection.
- A peer sends corrupted, truncated, or over-limit data: it is rejected without affecting other packets or other peers.
- The app is in the background or the device is asleep: sync is paused or continues according to platform limits, and resumes on return with no data loss.
- A device rapidly moves in and out of range: connection attempts are throttled so battery and the UI are not overwhelmed.
- Two peers connect to each other at the same moment from both sides: only one logical connection results.
- A peer's device identity changes or a stale cached peer is encountered: it is re-verified before any exchange.
- Message sizes exceed what one Bluetooth transmission can carry: large packets are split and reassembled transparently, and an incomplete message is discarded on timeout.

## Requirements *(mandatory)*

### Functional Requirements

**Transport contract**

- **FR-001**: The Bluetooth transport MUST implement the single Transport contract from spec 001 (lifecycle, support check, send/receive packets, sync-state exchange, blob hooks) and pass the shared Transport contract test suite with no changes to core code.
- **FR-002**: The transport MUST be a registrable module (spec 003), and apps MUST be able to enable or disable it per app and per Space.
- **FR-003**: The transport MUST run alongside other transports at the same time, with duplicate packets discarded by ID.
- **FR-004**: When Bluetooth is unsupported, disabled, or permission is denied, the transport MUST report "unsupported" or "unavailable" with a reason, and MUST NOT affect the rest of the app.

**Discovery and connection**

- **FR-005**: The transport MUST let a user discover nearby devices running the same app and connect to them without internet access.
- **FR-006**: Discovery MUST NOT disclose Space contents, object data, or membership lists to devices that have not proven membership in a shared Space.
- **FR-007**: A connection from a device the user has not previously trusted MUST require explicit user confirmation before any packets are exchanged.
- **FR-008**: The user MUST be able to see a recognizable name for each peer and disconnect or forget any peer at any time.
- **FR-009**: Previously trusted peers MUST be able to reconnect automatically when in range, if the user has allowed it, without repeating confirmation.

**Sync behavior**

- **FR-010**: On connect, peers MUST exchange sync state and send only the packets the other lacks, then stream new packets as they are created.
- **FR-011**: After an interrupted connection, sync MUST resume by exchanging only missing packets; partial packets MUST be discarded and re-requested.
- **FR-012**: Packets and messages larger than a single Bluetooth transmission MUST be split and reassembled transparently, with timeouts for incomplete messages.
- **FR-013**: Configurable size limits from spec 001 MUST apply to data received over Bluetooth, and over-limit input MUST be rejected.
- **FR-014**: The transport MUST support relaying packets to other transports and other Bluetooth peers per the Framework's relay rules, without loops.
- **FR-015**: Blobs MUST transfer using the blob rules from spec 004 (chunked, verified, resumable), at a priority that does not block ordinary packet sync, and the user MUST see progress.

**Security**

- **FR-016**: Packets received over Bluetooth MUST go through the same signature, role, and decryption checks as any other transport; the transport MUST be treated as untrusted and MUST NOT grant authority.
- **FR-017**: The wireless link MUST NOT expose plaintext object content beyond what the Framework already allows to untrusted relays (routing metadata only).
- **FR-018**: A peer that repeatedly sends invalid data MUST be disconnected and temporarily blocked.
- **FR-019**: The transport MUST limit concurrent connections and connection-attempt rates to protect battery and prevent nearby-device flooding.

**Status and feedback**

- **FR-020**: The app MUST be able to show connection state per peer (searching, connecting, syncing, idle, disconnected, error) and the number of packets pending in each direction.
- **FR-021**: Platform requirements the transport relies on (permissions, device support) MUST be documented, and failure to meet them MUST produce clear, user-friendly messages.

**Runtime scope**

- **FR-022**: The transport MUST work on [NEEDS CLARIFICATION: runtime scope — browser-only PWAs cannot connect to each other over Bluetooth; options are browser as client to a native/companion peer, an installable native wrapper on both ends, or a hybrid with graceful "unsupported" on browsers lacking support].

### Key Entities *(include if feature involves data)*

- **Bluetooth Peer**: A nearby device discovered or connected over Bluetooth. Attributes: display name, device identity, shared Spaces, trust state (unknown, trusted, blocked), connection state, last-seen time.
- **Peer Connection**: A live logical link to one peer, with its sync state, pending packet counts, and transfer progress.
- **Trusted Peer Record**: A user's saved decision to trust a peer, enabling reconnection; can be forgotten at any time.
- **Fragmented Message**: A packet or blob chunk split for transmission, with enough information to reassemble it or discard it on timeout.
- **Transport Status**: The reportable state of the whole transport (available, unsupported, unavailable, permission needed), plus the reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Two devices with no internet connection can discover each other, connect, and reach identical state for a 1,000-object Space in under 5 minutes.
- **SC-002**: After connection, a single edit on one device appears on the other within 3 seconds in 95% of cases.
- **SC-003**: After an interrupted sync, reconnecting transfers only missing data: 0 previously delivered packets are re-sent, and the final state matches an uninterrupted sync.
- **SC-004**: A device with no Space in common receives 0 packets and learns 0 object contents in all discovery and connection attempts.
- **SC-005**: A user can connect to a nearby colleague on first use in under 1 minute, with no more than 2 confirmation steps.
- **SC-006**: A relayed packet crosses a three-device chain (A–B–C) and is applied exactly once on each device, with no loops.
- **SC-007**: The transport passes 100% of the Transport contract test suite, and no core code changes are required.
- **SC-008**: Where Bluetooth is unavailable, 100% of app functions continue to work with no error dialogs beyond a single status message.
- **SC-009**: Keeping a trusted connection idle for one hour uses no more than a small, documented share of battery compared to the app with the transport off.

## Assumptions

- Users want local sync for small groups (roughly 2–8 nearby devices), not large crowds.
- Bluetooth throughput is far below Wi-Fi or internet, so text and structured data are the primary use; large blobs are best-effort.
- Spaces, keys, and signing from spec 002 already exist, and devices share a Space before connecting; the transport does not create identity or Space membership.
- Users grant the Bluetooth and nearby-device permissions the platform requires.
- Devices are within normal short-range Bluetooth distance (a room or building, not across a campus).
- The transport has no server component and does not rely on a cloud service for discovery or pairing.
- Supporting multiple operating systems equally is the goal, but platform differences in Bluetooth behavior are documented rather than hidden.
