// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'assert';
import Long from 'long';
import {
  GroupPublicParams,
  ProfileKeyCredentialPresentation,
  ServerSecretParams,
  ServerZkProfileOperations,
  UuidCiphertext,
} from '@signalapp/libsignal-client/zkgroup';

import { signalservice as Proto } from '../../protos/compiled';
import { Group } from '../data/group';

export type ServerGroupOptions = Readonly<{
  profileOps: ServerZkProfileOperations;
  zkSecret: ServerSecretParams;
  state: Proto.IGroup,
}>;

export type ModifyGroupResult = Readonly<{
  conflict: false;
  signedChange: Proto.IGroupChange;
} | {
  conflict: true;
  signedChange: undefined;
}>;

const { AccessRequired } = Proto.AccessControl;
const { Role } = Proto.Member;

export class ServerGroup extends Group {
  private readonly profileOps: ServerZkProfileOperations;
  private readonly zkSecret: ServerSecretParams;

  constructor({ profileOps, zkSecret, state }: ServerGroupOptions) {
    super();

    // TODO(indutny): use zod or something
    assert.ok(state.publicKey, 'Group public key must be present');
    assert.strictEqual(state.version, 0, 'Initial group version must be zero');
    assert.ok(state.accessControl, 'Group access control must be present');
    assert.ok(
      typeof state.accessControl.attributes === 'number' &&
        typeof state.accessControl.members === 'number' &&
        typeof state.accessControl.addFromInviteLink === 'number',
      'Group access control must be configured',
    );
    assert.ok(
      state.members && state.members.length > 0,
      'Group members must be present',
    );

    this.privPublicParams = new GroupPublicParams(Buffer.from(state.publicKey));
    this.profileOps = profileOps;
    this.zkSecret = zkSecret;

    const unrolledState = { ...state };

    unrolledState.members = state.members.map(
      (member) => this.unrollMember(member),
    );

    this.privChanges = {
      groupChanges: [ {
        groupState: unrolledState,
      } ],
    };
  }

  public modify(
    sourceACI: UuidCiphertext,
    sourcePNI: UuidCiphertext,
    actions: Proto.GroupChange.IActions,
  ): ModifyGroupResult {
    const appliedActions: Proto.GroupChange.IActions = {
      version: actions.version,
      sourceUuid: sourceACI.serialize(),
    };

    assert.ok(actions.version, 'Actions should have a new version');

    const timestamp = Long.fromNumber(Date.now());

    const newState = {
      ...this.state,
      version: actions.version,
    };

    const authMember = this.getMember(sourceACI);
    const { accessControl } = newState;

    let changeEpoch = 1;

    if (actions.modifyTitle) {
      this.verifyAccess(
        'title',
        authMember,
        accessControl?.attributes ?? AccessRequired.UNKNOWN,
      );

      appliedActions.modifyTitle = actions.modifyTitle;
      newState.title = actions.modifyTitle.title;
    }

    const deleteMembers = actions.deleteMembers ?? [];
    for (const { deletedUserId } of deleteMembers) {
      assert.ok(deletedUserId, 'Missing deletedUserId');

      this.verifyAccess(
        'members',
        authMember,
        accessControl?.members ?? AccessRequired.UNKNOWN,
        deletedUserId,
      );

      const member = this.getMember(
        new UuidCiphertext(Buffer.from(deletedUserId)),
      );
      assert.ok(member, 'Pending member not found for deletion');

      newState.members = (newState.members ?? []).filter(
        entry => entry !== member,
      );

      appliedActions.deleteMembers = [
        ...(appliedActions.deleteMembers ?? []),
        { deletedUserId },
      ];
    }

    const addPendingMembers = actions.addPendingMembers ?? [];
    for (const { added } of addPendingMembers) {
      assert.ok(added, 'Missing addPendingMember.added');

      const { member } = added;
      assert.ok(member, 'Missing addPendingMembers.added.member');

      const { userId, role } = member;
      assert.ok(userId, 'Missing addPendingMembers.added.member.userId');
      assert.ok(role, 'Missing addPendingMembers.added.member.role');

      this.verifyAccess(
        'pendingMembers',
        authMember,
        accessControl?.members ?? AccessRequired.UNKNOWN,
      );

      const newPendingMember = {
        member: { userId, role },
        addedByUserId: sourceACI.serialize(),
        timestamp,
      };

      newState.membersPendingProfileKey = [
        ...(newState.membersPendingProfileKey ?? []),
        newPendingMember,
      ];

      appliedActions.addPendingMembers = [
        ...(appliedActions.addPendingMembers ?? []),
        { added: newPendingMember },
      ];
    }

    const deletePendingMembers = actions.deletePendingMembers ?? [];
    for (const { deletedUserId } of deletePendingMembers) {
      assert.ok(deletedUserId, 'Missing deletedUserId');

      assert.ok(
        Buffer.from(deletedUserId).equals(sourceACI.serialize()) ||
          Buffer.from(deletedUserId).equals(sourcePNI.serialize()),
        'Not a pending member',
      );

      const pendingMember = this.getPendingMember(
        new UuidCiphertext(Buffer.from(deletedUserId)),
      );
      assert.ok(pendingMember, 'Pending member not found for deletion');

      newState.membersPendingProfileKey =
        (newState.membersPendingProfileKey ?? []).filter(
          entry => entry !== pendingMember,
        );

      appliedActions.deletePendingMembers = [
        ...(appliedActions.deletePendingMembers ?? []),
        { deletedUserId },
      ];
    }

    const promotePendingMembers = actions.promotePendingMembers ?? [];
    for (const { presentation } of promotePendingMembers) {
      assert.ok(
        presentation,
        'Missing presentation in promotePendingMembers',
      );
      const presentationFFI = new ProfileKeyCredentialPresentation(
        Buffer.from(presentation),
      );
      this.profileOps.verifyProfileKeyCredentialPresentation(
        this.publicParams,
        presentationFFI,
      );

      assert.ok(
        presentationFFI.getUuidCiphertext().serialize().equals(
          sourceACI.serialize(),
        ),
        'Not a pending member',
      );

      const pendingMember = this.getPendingMember(
        presentationFFI.getUuidCiphertext(),
      );
      assert.ok(pendingMember, 'No pending member');
      assert.ok(
        !this.getMember(presentationFFI.getUuidCiphertext()),
        'Member is both pending and active',
      );

      newState.membersPendingProfileKey =
        (newState.membersPendingProfileKey ?? []).filter(
          entry => entry !== pendingMember,
        );

      const userId = presentationFFI.getUuidCiphertext().serialize();
      const profileKey = presentationFFI.getProfileKeyCiphertext().serialize();

      newState.members = [
        ...(newState.members ?? []),
        {
          role: Role.DEFAULT,
          userId,
          profileKey,
        },
      ];

      appliedActions.promotePendingMembers = [
        ...(appliedActions.promotePendingMembers ?? []),
        { userId, profileKey },
      ];
    }

    const promotePNIMembers = actions.promoteMembersPendingPniAciProfileKey;
    for (const { presentation } of promotePNIMembers ?? []) {
      assert.ok(
        presentation,
        'Missing presentation in promoteMembersPendingPniAciProfileKey',
      );
      const presentationFFI = new ProfileKeyCredentialPresentation(
        Buffer.from(presentation),
      );

      this.profileOps.verifyProfileKeyCredentialPresentation(
        this.publicParams,
        presentationFFI,
      );

      const aci = presentationFFI.getUuidCiphertext();
      const pni = sourcePNI;
      const profileKey = presentationFFI.getProfileKeyCiphertext();

      assert.ok(
        aci.serialize().equals(sourceACI.serialize()),
        'Not a pending member',
      );

      const pendingMember = this.getPendingMember(pni);
      assert.ok(pendingMember, 'No pending pni member');
      assert.ok(!this.getMember(aci), 'ACI is already a member');

      newState.membersPendingProfileKey =
        (newState.membersPendingProfileKey ?? []).filter(
          entry => entry !== pendingMember,
        );

      newState.members = [
        ...(newState.members ?? []),
        {
          role: Role.DEFAULT,
          userId: aci.serialize(),
          profileKey: profileKey.serialize(),
        },
      ];

      changeEpoch = Math.max(changeEpoch, 5);
      appliedActions.sourceUuid = sourcePNI.serialize();
      appliedActions.promoteMembersPendingPniAciProfileKey = [
        ...(appliedActions.promoteMembersPendingPniAciProfileKey ?? []),
        {
          userId: aci.serialize(),
          pni: pni.serialize(),
          profileKey: profileKey.serialize(),
        },
      ];
    }

    const { version: oldVersion } = this.state;
    assert.ok(
      typeof oldVersion === 'number',
      'Group must have existing version',
    );
    if (actions.version !== oldVersion + 1) {
      return { conflict: true, signedChange: undefined };
    }

    const encodedActions = Proto.GroupChange.Actions.encode(
      appliedActions,
    ).finish();
    const serverSignature = this.zkSecret.sign(
      Buffer.from(encodedActions),
    ).serialize();

    const groupChange: Proto.IGroupChange = {
      actions: encodedActions,
      changeEpoch,
    };

    assert.ok(this.privChanges?.groupChanges, 'Must be initialized');
    this.privChanges.groupChanges.push({
      groupChange,
      groupState: newState,
    });

    return {
      conflict: false,
      signedChange: {
        ...groupChange,
        serverSignature,
      },
    };
  }

  //
  // Private
  //

  private verifyAccess(
    attribute: string,
    member: Proto.IMember | undefined,
    access: Proto.AccessControl.AccessRequired,
    affectedUserId?: Uint8Array,
  ): void {
    // Changing something about ourselves is always allowed
    if (
      member?.userId &&
      affectedUserId &&
      Buffer.from(member.userId).equals(affectedUserId)
    ) {
      return;
    }

    switch (access) {
    case AccessRequired.ANY:
      break;

    case AccessRequired.MEMBER:
      assert.ok(member, `Must be a member to access: ${attribute}`);
      break;

    case AccessRequired.ADMINISTRATOR:
      assert.strictEqual(
        member?.role,
        Role.ADMINISTRATOR,
        `Must be an administrator to modify: ${attribute}`,
      );
      break;

    case AccessRequired.UNSATISFIABLE:
      throw new Error(`Unsatisfiable access attribute: ${attribute}`);

    case AccessRequired.UNKNOWN:
      throw new Error(`Unknown access for attribute: ${attribute}`);
    }
  }

  private unrollMember({ role, presentation }: Proto.IMember): Proto.IMember {
    assert.strictEqual(
      typeof role,
      'number',
      'Group member role is undefined',
    );
    assert.ok(
      presentation,
      'Group member presentation is undefined',
    );

    const presentationFFI = new ProfileKeyCredentialPresentation(
      Buffer.from(presentation),
    );
    this.profileOps.verifyProfileKeyCredentialPresentation(
      this.publicParams,
      presentationFFI,
    );

    return {
      role,
      userId: presentationFFI.getUuidCiphertext().serialize(),
      profileKey: presentationFFI.getProfileKeyCiphertext().serialize(),
    };
  }
}
