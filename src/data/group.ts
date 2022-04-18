// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'assert';
import {
  GroupPublicParams,
  UuidCiphertext,
} from '@signalapp/libsignal-client/zkgroup';

import { signalservice as Proto } from '../../protos/compiled';

export abstract class Group {
  protected privChanges?: Proto.IGroupChanges;
  protected privPublicParams?: GroupPublicParams;

  public get changes(): Proto.IGroupChanges {
    assert(this.privChanges !== undefined, 'Group not initialized');
    return this.privChanges;
  }

  public get publicParams(): GroupPublicParams {
    assert(this.privPublicParams !== undefined, 'Group not initialized');
    return this.privPublicParams;
  }

  public get state(): Proto.IGroup {
    const { groupChanges } = this.changes;
    assert(groupChanges, 'Missing group changes in the group state');
    const state = groupChanges[groupChanges.length - 1].groupState;
    assert(state, 'Group must have the last state');
    return state;
  }

  public getChangesSince(since: number): Proto.IGroupChanges {
    return {
      groupChanges: this.changes.groupChanges?.slice(since),
    };
  }

  public getMember(
    uuidCiphertext: UuidCiphertext,
  ): Proto.IMember | undefined {
    const state = this.state;
    const userId = uuidCiphertext.serialize();
    return state.members?.find((member) => {
      if (!member.userId) {
        return false;
      }

      return userId.equals(member.userId);
    }) ?? undefined;
  }
}
