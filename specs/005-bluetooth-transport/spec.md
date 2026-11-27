# Feature Specification: Bluetooth Local Transport

**Feature Branch**: `005-bluetooth-transport`

**Created**: 2026-11-27

**Status**: Draft

**Input**: User description: "Build a transport plugin that uses Bluetooth to sync and communicate locally between clients to support offline usage."

This spec adds a Bluetooth transport plugin implementing the Transport contract from spec 001. It lets nearby devices exchange Data Packets (and blobs, per spec 004) with no internet, no server, and no shared Wi-Fi. Browser apps (tablets, laptops, phones) connect over Bluetooth to a nearby **Hub**, an Android or desktop app that someone leaves running in the area and that stores and forwards encrypted packets between everyone connected to it. It builds on the Transport contract (001), Space membership and signing (002), module registration (003), and blob transfer (004). It changes none of them.

## Clarifications

### Session 2026-11-27

- Q: Where must the Bluetooth transport work? → A: Browser PWAs cannot connect to each other over Bluetooth, so the transport uses a **Hub** model. A Hub is a separate app for **Android** or **desktop** (Windows, macOS, Linux). Browser clients connect to a Hub over Bluetooth and need no helper installed on the client device. Browsers that cannot use Bluetooth report the transport as unavailable.
- Q: Is the helper on the same device as the app, or elsewhere? → A: The Hub is a shared, always-on device that many clients connect to, for example a laptop or phone left at a campsite, during an internet outage, or at an event. Clients do not each need their own helper.
- Q: By default, does a Hub accept any client in a served Space or only owner-approved clients? → A: Open by default: any client that proves membership in a Space the Hub serves can connect with no owner approval. The Hub owner can switch the Hub to approval-required mode, and can block any client at any time.
- Q: How does a Hub owner choose which Spaces the Hub serves? → A: Both. The owner adds Spaces explicitly by exporting a "serve this Space" code (QR or pasted, carrying no keys) from their browser app. The owner can also turn on automatic mode, in which the Hub stores packets for any Space a connecting client brings, up to its storage limit; automatic mode is off by default.
- Q: How long does a Hub keep a stored packet by default? → A: 14 days, with the oldest already-delivered packets dropped first if storage fills sooner. The owner can change the period.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sync Nearby Devices Through a Hub With No Network (Priority: P1)

A group is somewhere with no internet (a campsite, an event, an outage). One person leaves a laptop or phone running the Hub. Others open the app on their tablets, laptops, or phones, connect to the Hub over Bluetooth, and changes made on any device appear on the others.

**Why this priority**: This is the whole point of the feature: working collaboration when there is no network at all, without every device needing special software.

**Independent Test**: Put a Hub and two client devices in airplane mode with Bluetooth on, create objects on each client, connect them to the Hub, and verify both clients converge to the same state.

**Acceptance Scenarios**:

1. **Given** two clients in the same Space and a running Hub with no internet, **When** both connect to the Hub over Bluetooth, **Then** all packets each has and the other lacks are exchanged through the Hub until both hold the same state.
2. **Given** connected clients, **When** a user edits an object, **Then** the change appears on the other clients within a few seconds with no user action.
3. **Given** a client that has never met this Hub, **When** it connects, **Then** the user needs no address, code, or account beyond an on-screen confirmation.
4. **Given** no Hub in range, or a browser without Bluetooth support, **When** the user opens the Bluetooth screen, **Then** they are told no Hub was found (and how to run one), and the app works normally on other transports.
5. **Given** a connection is established, **When** the app is also connected to another transport, **Then** both run simultaneously and packets are deduplicated by ID.

---

### User Story 2 - Discover and Choose Nearby Peers Safely (Priority: P1)

A user opens the Bluetooth connection screen and sees nearby Hubs. They connect only to a Hub that serves a Space they share, and are never exposed to data from Spaces they are not in. A Hub owner can restrict who may connect.

**Why this priority**: A local radio transport is reachable by strangers. Without safe discovery and trust, the feature is a data-leak risk.

**Independent Test**: Place a Hub and three clients nearby, two sharing a Space with the Hub and one outside it. Verify the outsider cannot read any packets or learn Space contents, and the user can tell the devices apart.

**Acceptance Scenarios**:

1. **Given** several nearby Hubs, **When** the user opens the connection screen, **Then** they see each Hub with a human-readable name and which shared Spaces apply.
2. **Given** a client that shares no Space with the Hub, **When** it attempts to connect, **Then** it receives no packets and no Space content, and the attempt is rejected.
3. **Given** a Hub in its default open mode, **When** a client that proves membership in a served Space connects, **Then** it syncs with no approval step; **Given** the owner has switched the Hub to approval-required mode, **When** an unknown client connects, **Then** nothing is exchanged until the owner approves it.
4. **Given** a peer sends a packet with an invalid signature or from an author without a role in the Space, **When** it arrives over Bluetooth, **Then** it is rejected exactly as on any other transport.

---

### User Story 3 - Resume and Survive Dropouts (Priority: P2)

A client is syncing with a Hub and its user walks out of range or the screen locks. When the client is back in range, sync resumes by exchanging only what is missing, without duplicating or corrupting data.

**Why this priority**: Bluetooth links are short-range and unstable; graceful recovery is what makes the transport usable in practice.

**Independent Test**: Start a large sync, interrupt the connection midway, reconnect, and verify the final state is correct and that previously received packets are not re-sent.

**Acceptance Scenarios**:

1. **Given** a sync interrupted halfway, **When** the client reconnects to the Hub, **Then** only the missing packets are exchanged.
2. **Given** a Hub that a client previously trusted and is now back in range, **When** reconnection is enabled, **Then** the client reconnects without re-pairing.
3. **Given** a client was offline while others edited, **When** it reconnects, **Then** it receives everything the Hub stored for it in the meantime.
4. **Given** the connection drops while a packet is half-sent, **When** the sync resumes, **Then** the partial packet is discarded and re-requested without affecting other packets.

---

### User Story 4 - Hub Stores and Forwards for Everyone (Priority: P2)

Alice edits on her tablet and leaves the campsite area. Later Bob connects his laptop to the Hub and receives Alice's changes, even though Alice and Bob were never connected at the same time. Where several Hubs exist (for example, one at camp and one in a vehicle), they can also sync with each other.

**Why this priority**: A hub that only forwards live traffic would force everyone to be present at once. Store-and-forward is what makes a hub useful for outings and outages.

**Independent Test**: The Hub owner adds the Space with a serve-Space code. Client A connects, writes, and disconnects. Client B then connects and verifies it receives A's changes from the Hub. Then connect two Hubs and verify clients on each converge.

**Acceptance Scenarios**:

1. **Given** client A wrote and disconnected, **When** client B connects to the same Hub, **Then** B receives A's packets.
2. **Given** a Hub with several clients, **When** packets are forwarded, **Then** no packet is applied twice or looped indefinitely.
3. **Given** two Hubs within range of each other, **When** they connect, **Then** they exchange the packets each is missing and their clients converge.
4. **Given** a Hub that is also connected to an internet transport, **When** packets arrive on one, **Then** they can be relayed to the other, subject to the per-app and per-Space relay settings.
5. **Given** a Hub that never holds Space keys, **When** it stores and forwards packets, **Then** it cannot read their content.

---

### User Story 5 - Sync Larger Content Locally (Priority: P3)

Users nearby also want to share photos or files attached to objects. Blobs transfer over the Bluetooth link, slowly but reliably, with visible progress and the ability to continue later.

**Why this priority**: Valuable, but text and structured objects are the core need; the link's speed limits how much it can carry.

**Independent Test**: Attach a blob to an object on client A, then connect client B to the Hub over Bluetooth, and verify the blob arrives intact with progress shown, and resumes after an interruption.

**Acceptance Scenarios**:

1. **Given** a blob attached to a synced object, **When** a client connects to the Hub, **Then** the blob transfers using the blob rules from spec 004 and is verified on arrival.
2. **Given** a blob transfer in progress, **When** the user views the app, **Then** progress is visible and normal packet sync is not starved by the transfer.
3. **Given** a blob too large to transfer practically over Bluetooth, **When** a client connects, **Then** the user is told it will wait for a faster transport rather than failing silently.

---

### Edge Cases

- Bluetooth is turned off, permission is denied, or the device has no Bluetooth: the transport reports itself unsupported or unavailable and the app continues on other transports or fully offline.
- The Hub is stopped, runs out of battery, or crashes: clients report the transport as "unavailable", their own changes stay safe in the local outbox, and sync resumes when a Hub returns. Packets stored on the Hub survive a restart.
- A client and Hub are on different versions: they negotiate a compatible version or show a clear "update needed" message.
- More clients try to connect than the Hub can serve: extra clients are told the Hub is full and can retry, and clients already connected are unaffected.
- A peer sends corrupted, truncated, or over-limit data: it is rejected without affecting other packets or other peers.
- The app is in the background or the device is asleep: sync is paused or continues according to platform limits, and resumes on return with no data loss.
- A device rapidly moves in and out of range: connection attempts are throttled so battery and the UI are not overwhelmed.
- Two peers connect to each other at the same moment from both sides: only one logical connection results.
- A client or Hub identity changes, or a stale cached peer is encountered: it is re-verified before any exchange.
- A blocked client reconnects or a client proves membership in no served Space: the Hub rejects it without revealing which Spaces it serves or what it stores.
- Several Hubs are in range of one client: the user picks which to use, and the client may connect to more than one at once.
- A client brings a Space the Hub is not set to serve while automatic mode is off: the Hub rejects it with a message that says the owner must add that Space, without revealing what the Hub stores.
- A client returns after the retention period has passed: it may be missing packets the Hub dropped, and the user is told those changes need to come from another device or Hub.
- The Hub's storage fills up: the oldest already-delivered packets are dropped first and the Hub owner is warned; no undelivered packet is silently lost.
- Message sizes exceed what one Bluetooth transmission can carry: large packets are split and reassembled transparently, and an incomplete message is discarded on timeout.

## Requirements *(mandatory)*

### Functional Requirements

**Transport contract**

- **FR-001**: The Bluetooth transport MUST implement the single Transport contract from spec 001 (lifecycle, support check, send/receive packets, sync-state exchange, blob hooks) and pass the shared Transport contract test suite with no changes to core code.
- **FR-002**: The transport MUST be a registrable module (spec 003), and apps MUST be able to enable or disable it per app and per Space.
- **FR-003**: The transport MUST run alongside other transports at the same time, with duplicate packets discarded by ID.
- **FR-004**: When Bluetooth is unsupported by the browser or device, disabled, or permission is denied, the transport MUST report "unsupported" or "unavailable" with a reason, and MUST NOT affect the rest of the app.

**Hub**

- **FR-005**: v1 MUST ship a Hub for Android and a Hub for desktop (Windows, macOS, Linux). A Hub is a standalone app that runs on a phone or computer and serves nearby clients over Bluetooth.
- **FR-006**: Browser clients MUST connect to a Hub over Bluetooth with no helper or extra software on the client device.
- **FR-007**: A Hub MUST store the encrypted packets and blobs it receives and forward them to every connected client in the relevant Space, including clients that connect later (store-and-forward).
- **FR-008**: A Hub MUST serve several clients and several Spaces at once, keeping each Space's data separate, and MUST keep running unattended (with the screen off or the app in the background, within platform limits).
- **FR-009**: A Hub MUST persist its stored packets across restarts. By default it MUST keep each packet for 14 days, and the owner MUST be able to change the retention period and the storage limit. When storage fills before a packet expires, the Hub MUST drop the oldest already-delivered packets first and warn the owner.
- **FR-010**: Hubs in range of each other MUST be able to sync with each other so that clients on different Hubs converge. Android and desktop Hubs MUST interoperate.
- **FR-011**: A Hub MUST NOT hold Space keys or be able to read packet content. It MUST be treated as an untrusted relay (Constitution Principles IV and V), seeing only routing metadata.
- **FR-012**: A Hub owner MUST be able to see connected clients, choose which Spaces the Hub serves, switch between open mode (default) and approval-required mode, switch automatic Space mode on or off, and disconnect or block any client.

**Discovery and connection**

- **FR-013**: A Hub MUST start serving a Space when the owner provides a "serve this Space" code exported from a member's app; the code MUST carry no keys and MUST NOT let the Hub read content. With automatic Space mode off (the default), a Hub MUST NOT store packets for Spaces the owner has not added.
- **FR-014**: With automatic Space mode on, a Hub MUST store packets for Spaces its connecting clients bring, up to its storage limit, with a per-Space cap so one Space cannot use all storage, and MUST show the owner which Spaces were added automatically and let them remove any.
- **FR-015**: A client MUST be able to discover nearby Hubs and connect to one without internet access.
- **FR-016**: Discovery MUST NOT disclose Space contents, object data, or membership lists to devices that have not proven membership in a shared Space.
- **FR-017**: In open mode (the default), a Hub MUST accept any client that proves membership in a Space the Hub serves, with no owner approval. In approval-required mode, a new client MUST be approved by the Hub owner before any packets are exchanged. Either way, the client MUST confirm on first use which Hub it is connecting to.
- **FR-018**: Users MUST see a recognizable name for each Hub and MUST be able to disconnect from or forget a Hub at any time.
- **FR-019**: A client MUST be able to reconnect automatically to a previously trusted Hub that comes back in range, if the user has allowed it.
- **FR-020**: A client MUST be able to be connected to more than one Hub at the same time.

**Sync behavior**

- **FR-021**: On connect, client and Hub MUST exchange sync state and send only the packets the other lacks, then stream new packets as they are created.
- **FR-022**: After an interrupted connection, sync MUST resume by exchanging only missing packets; partial packets MUST be discarded and re-requested.
- **FR-023**: Packets and messages larger than a single Bluetooth transmission MUST be split and reassembled transparently, with timeouts for incomplete messages.
- **FR-024**: Configurable size limits from spec 001 MUST apply to data received over Bluetooth, and over-limit input MUST be rejected.
- **FR-025**: The transport MUST support relaying packets between Bluetooth and other transports per the Framework's relay rules, without loops.
- **FR-026**: Blobs MUST transfer using the blob rules from spec 004 (chunked, verified, resumable), at a priority that does not block ordinary packet sync, and the user MUST see progress.

**Security**

- **FR-027**: Packets received over Bluetooth MUST go through the same signature, role, and decryption checks as on any other transport; the transport MUST NOT grant authority to any peer or Hub.
- **FR-028**: A client or Hub that repeatedly sends invalid data MUST be disconnected and temporarily blocked.
- **FR-029**: A Hub MUST limit concurrent clients and connection-attempt rates, tell clients that cannot be served that the Hub is full, and not let a nearby device flood it.

**Status and feedback**

- **FR-030**: The app MUST be able to show connection state per Hub (searching, connecting, syncing, idle, disconnected, full, error) and the number of packets pending in each direction.
- **FR-031**: Platform requirements (permissions, browser and device support) MUST be documented, and failure to meet them MUST produce clear, user-friendly messages. This includes telling the user when their browser cannot use Bluetooth at all.

### Key Entities *(include if feature involves data)*

- **Hub**: An Android or desktop app that stores and forwards encrypted packets between nearby clients and other Hubs. Attributes: display name, platform, version, Spaces served, storage limit and retention policy, access mode (open or approval-required), connected clients.
- **Client**: A browser app connecting to a Hub over Bluetooth. Attributes: display name, device identity, shared Spaces, trust state (unknown, trusted, blocked).
- **Hub Connection**: A live logical link between one client (or Hub) and one Hub, with its sync state, pending packet counts, and transfer progress.
- **Trusted Hub Record**: A user's saved decision to trust a Hub, enabling reconnection; can be forgotten at any time.
- **Serve-Space Code**: A keyless code exported from a member's app that tells a Hub to store and forward one Space. Attributes: Space identifier, optional expiry.
- **Stored Packet Set**: The encrypted packets and blobs a Hub holds per Space for later delivery, with delivery state per client.
- **Fragmented Message**: A packet or blob chunk split for transmission, with enough information to reassemble it or discard it on timeout.
- **Transport Status**: The reportable state of the transport (available, unsupported, unavailable, permission needed, Hub full), plus the reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client with no internet connection can discover a Hub, connect, and reach identical state for a 1,000-object Space in under 5 minutes.
- **SC-002**: With two clients connected to one Hub, a single edit on one appears on the other within 3 seconds in 95% of cases.
- **SC-003**: After an interrupted sync, reconnecting transfers only missing data: 0 previously delivered packets are re-sent, and the final state matches an uninterrupted sync.
- **SC-004**: A device with no Space in common receives 0 packets and learns 0 object contents in all discovery and connection attempts, and a Hub holds 0 Space keys in all tests.
- **SC-005**: A user can connect to a nearby Hub on first use in under 1 minute, with no more than 2 confirmation steps.
- **SC-006**: A client that was never connected at the same time as another client receives that client's changes through the Hub, and every packet is applied exactly once with no loops.
- **SC-007**: The transport passes 100% of the Transport contract test suite, and no core code changes are required.
- **SC-008**: Where Bluetooth or a Hub is unavailable, 100% of app functions continue to work with no error dialogs beyond a single status message.
- **SC-009**: A Hub left running unattended for 8 hours with a typical group (8 clients connecting and disconnecting) loses 0 undelivered packets, and its battery or resource use is documented.
- **SC-010**: A person can install and start a Hub on Android or desktop in under 5 minutes, following on-screen guidance only.
- **SC-011**: Clients on an Android Hub and clients on a desktop Hub converge when the two Hubs connect, in 100% of interoperability tests.

## Assumptions

- The target scenarios are small groups (roughly 2–8 clients per Hub) at camps, outings, events, and during outages, not large crowds. A Hub serves at least 8 clients at once.
- Bluetooth throughput is far below Wi-Fi or internet, so text and structured data are the primary use; large blobs are best-effort.
- Spaces, keys, and signing from spec 002 already exist, and clients share a Space with the Hub's served Spaces before connecting; the transport does not create identity or Space membership. A Hub learns which Spaces to serve from keyless serve-Space codes or, in automatic mode, from routing identifiers, never from Space keys.
- In open mode, a stranger who is a member of a served Space can connect and download that Space's encrypted packets; this is acceptable because members are already allowed to hold them, and non-members never connect. Owners who want tighter control use approval-required mode.
- Out of scope for v1: direct client-to-client Bluetooth between two browsers (browsers cannot accept Bluetooth connections), iOS clients and Hubs, and any Hub feature that reads Space content.
- Users grant the Bluetooth and nearby-device permissions the platform requires.
- Clients are within normal short-range Bluetooth distance of the Hub (a room, a tent area, or a building floor, not a campus).
- The Hub is a local relay, not a cloud server: it needs no internet and no account.
- Client browsers need Bluetooth support from the browser. Browsers or devices without it (for example iOS browsers) report the transport as unavailable and use other transports. iOS clients and iOS Hubs are out of scope for v1.
- A person who runs a Hub and also wants to use the app on that same device does so through a browser client like anyone else.
- Hub apps are distributed separately from the PWA; how they are published and installed is decided in planning.
- Platform differences in Bluetooth behavior are documented rather than hidden.
