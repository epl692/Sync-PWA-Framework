# Feature Specification: Spaces, Security & Identity

**Feature Branch**: `002-spaces-security-identity`
**Created**: 2026-10-20
**Status**: Draft
**Depends on**: 001-sync-core (packet validators, payload codec, transports)
**Depended on by**: 004-blob-sync (blob encryption keys)
**Input**: User description: "Multi-user, shared data. End-to-end encrypted packets. Permissions enforced by signed packets that every peer verifies. Objects live in Spaces with optional per-object overrides. Identity is pluggable, with invite link/QR as the default."

## Scope

Spaces and membership, the three fixed roles, end-to-end encryption of packet payloads, packet signing and verification, key rotation, per-object override shares, and the pluggable Identity Provider contract with its default invite/QR provider.

This spec plugs into spec 001 by supplying the **encrypting payload codec** and the **signature/role packet validator**.

## Clarifications

### Session 2026-10-20

- Q: Who shares data? → A: Multi-user, shared Spaces.
- Q: Data privacy level? → A: End-to-end encrypted packets.
- Q: How are permissions enforced? → A: Signed packets, verified by every peer.
- Q: Unit of sharing? → A: Spaces, with optional per-object override shares.
- Q: How do users/devices join? → A: Pluggable identity providers; invite link/QR is the default.
- Q: Permission model? → A: Fixed Owner/Editor/Viewer roles only.
- Q: Can a new member read data written before they joined? → A: Yes, joiners can read all existing history in the Space.
- Q: Can Space Owners outside an override share read or edit it? → A: No; only the share's own members can.
- Q: Are a removed member's unsynced offline changes kept? → A: No; changes the removing Owner hadn't received are discarded and the count reported.
- Q: Must an Owner approve each invite acceptance? → A: Approval required by default; the Owner can choose automatic per invite.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a Private Shared Space (Priority: P1)

An End User creates a Space (e.g. "Family"). Everything written in it is encrypted before it leaves the device, and servers or relays only ever see ciphertext.

**Why this priority**: E2E encryption is a constitution-level requirement; nothing ships without it.

**Independent Test**: Create a Space, write objects, sync via the reference relay server, inspect the server's stored data for plaintext.

**Acceptance Scenarios**:

1. **Given** a new Space, **When** it is created, **Then** the creator is its Owner and a Space key is generated on their device.
2. **Given** a Space, **When** any packet leaves a device, **Then** its payload is encrypted with the current Space key.
3. **Given** a relay or server transport, **When** it stores packets, **Then** it can read only envelope routing metadata, never payloads.

---

### User Story 2 - Peers Enforce Roles (Priority: P1)

A Viewer in a Space tries to edit an object (e.g. using a modified client). Every other peer rejects the change.

**Why this priority**: With E2E encryption and P2P transports, there is no server to enforce permissions; peers must.

**Independent Test**: Inject packets from a Viewer, a non-member, and a forged signature; verify no peer applies them.

**Acceptance Scenarios**:

1. **Given** any packet, **When** it is authored, **Then** it is signed by the author's device key.
2. **Given** a packet whose signature doesn't verify, **When** it arrives, **Then** it is rejected.
3. **Given** a packet from a member whose role doesn't permit the operation, **When** it arrives, **Then** it is rejected and not applied.
4. **Given** a rejected packet, **When** relaying, **Then** the device does not forward it.

---

### User Story 3 - Invite Someone With a Link or QR (Priority: P2)

An Owner invites a new member by link or QR code, choosing their role. It works even with no internet, between two nearby devices over Bluetooth.

**Why this priority**: Required for multi-user; one default provider is enough to start.

**Independent Test**: Invite a device via QR with no internet, verify it can decrypt and write per its role.

**Acceptance Scenarios**:

1. **Given** an Owner, **When** they create an invite, **Then** it grants a specific role in a specific Space and has an expiry, a use limit, and an approval setting (required by default).
2. **Given** a valid invite and no internet, **When** a nearby device accepts it over a local transport, **Then** it receives all of the Space's key epochs (so it can read existing history) and its device key is registered as a member.
3. **Given** an expired or used-up invite, **When** someone tries to accept it, **Then** it is refused.

---

### User Story 4 - Link My Other Devices (Priority: P2)

A user adds their tablet to their account. It gets all their Spaces, and its edits are attributed to the same user.

**Independent Test**: Link a second device, verify it receives all the user's Spaces and its packets show the same user.

**Acceptance Scenarios**:

1. **Given** a user with one device, **When** they link a second device, **Then** the new device gets its own device key under the same user identity.
2. **Given** a linked device, **When** it writes, **Then** peers attribute the packet to the user and verify it with that device's key.
3. **Given** a lost device, **When** the user revokes it from another device, **Then** its later packets are rejected and affected keys rotate.

---

### User Story 5 - Remove a Member (Priority: P2)

An Owner removes a member. The removed member can no longer read anything new written in the Space.

**Independent Test**: Remove a member, write new objects, verify the removed device cannot decrypt them.

**Acceptance Scenarios**:

1. **Given** a member is removed, **When** removal is applied, **Then** the Space key is rotated and the new key is shared only with remaining members.
2. **Given** a removed member's packet, **When** its clock is after the removal or it was not received by the remover before removal, **Then** peers reject it.
3. **Given** a Space, **When** the last Owner tries to leave or be demoted, **Then** it is refused unless another Owner exists.

---

### User Story 6 - Share One Object Privately (Priority: P3)

A user shares a single object in a Space with only some of its members (e.g. a surprise gift list inside "Family").

**Independent Test**: Create an override share; verify Space members outside it cannot decrypt the object.

**Acceptance Scenarios**:

1. **Given** an object, **When** a user creates an override share for it, **Then** it gets its own member list, roles, and key.
2. **Given** a Space member outside the override, **When** they receive its packets, **Then** they can store and relay them but cannot decrypt or view them.

---

### User Story 7 - Swap the Identity Provider (Priority: P3)

An App Developer replaces invite/QR identity with a different provider (e.g. an organization login) without changing other code.

**Independent Test**: Run the Identity Provider contract suite against the default provider and a stub provider.

**Acceptance Scenarios**:

1. **Given** a provider that passes the contract suite, **When** it is configured, **Then** Spaces, signing, and encryption work unchanged.

---

### Edge Cases

- Two Owners make conflicting membership changes offline (e.g. each removes the other).
- Two people accept the same single-use invite at the same time.
- A packet signed by a device whose membership was revoked, with a clock before the revocation.
- A member is offline across several key rotations and must catch up on keys.
- An invite QR is photographed by someone else.
- A device is lost and has no other device to revoke it from.

## Requirements *(mandatory)*

### Functional Requirements

**Spaces & roles**

- **FR-001**: Every object MUST belong to a Space; Space members share the Space key and have exactly one role.
- **FR-002**: v1 MUST use three fixed roles: Owner (manage members, roles, keys, and all objects), Editor (create, update, delete objects), Viewer (read only). Custom roles are out of scope.
- **FR-003**: A Space MUST always have at least one Owner.
- **FR-004**: Membership and role changes MUST themselves be signed packets in the Space, verified like any other packet.
- **FR-005**: Concurrent conflicting membership changes MUST resolve deterministically on all peers. [Assumption: per-member last-writer-wins, with removal winning ties; revisit in /plan.]

**Encryption & signing**

- **FR-006**: Packet payloads MUST be encrypted on the authoring device before leaving it; only routing metadata (packet ID, Space ID, key epoch, author device ID, clock) MAY be visible to transports.
- **FR-007**: Every packet MUST be signed by the author's device key; peers MUST verify signature and role before applying or relaying.
- **FR-008**: Removing a member or revoking a device MUST rotate affected keys; later packets MUST be unreadable to the removed party.
- **FR-009**: Peers MUST reject packets from a revoked device or removed member whose clock is after the revocation, and packets the revoking device had not yet received from it when it revoked (a sequence-number cutoff recorded in the removal), because a revoked device's clock cannot be trusted. Rejected changes MUST be counted and reported to the user.
- **FR-010**: Members MUST be able to obtain all key epochs they are entitled to after being offline. A newly joined member is entitled to every existing key epoch of the Space, so it can read all history written before it joined.

**Override shares**

- **FR-011**: The Framework MUST support per-object override shares with their own member list, roles, and key.
- **FR-011a**: Space Owner status MUST NOT grant access to an override share. Only the share's own members and roles apply. Removing a user from the Space removes them from every override share.
- **FR-012**: Space members outside an override share MUST still store and relay its packets without being able to decrypt them.

**Identity**

- **FR-013**: Identity MUST be provided through a pluggable Identity Provider contract (create user, link device, revoke device, create/accept invite) with a contract test suite.
- **FR-014**: The default provider MUST support invite links and QR codes with role, expiry, and use limit, including fully offline acceptance over a local transport. Each invite MUST require Owner approval of the joining device by default, and the Owner MAY choose automatic acceptance per invite. The approval screen MUST show a short code both devices display, so a copied or photographed invite can be spotted.
- **FR-015**: A user MUST be able to link multiple devices, each with its own device key, under one user identity, and revoke any of them from another linked device.

### Key Entities

- **Space**: members, roles, key epochs, settings (relay, retention).
- **Override Share**: per-object sub-share with members, roles, and key epochs.
- **User**: identity with one or more devices.
- **Device**: holds a device signing key; belongs to one user.
- **Membership**: user + role in a Space or override share.
- **Key Epoch**: a version of a Space/override key, created on rotation.
- **Invite**: grants a role in a Space; has expiry and use limit.
- **Identity Provider**: plugin that establishes users, devices, and invites.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 packets with invalid signatures, insufficient roles, or revoked authors are applied in adversarial tests.
- **SC-002**: Data stored by the reference relay server contains no plaintext payload fields (automated check).
- **SC-003**: After a member is removed, 100% of packets written afterward are undecryptable on the removed device.
- **SC-004**: A new member can join via QR with no internet in under 60 seconds.
- **SC-005**: A stub Identity Provider passing the contract suite works without changes to other code.

## Assumptions

- Offline joining over Bluetooth needs two Chromium-based devices in v1 (Web Bluetooth limits); iOS joins via link over WebSocket.
- Losing every device of a user means losing access to their identity unless another member re-invites them; account recovery is out of scope for v1.
- Removed members keep anything they already decrypted; rotation protects only future data.
