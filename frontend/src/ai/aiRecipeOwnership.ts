import { useAuthStore } from '../auth/authStore';
import { getActiveDataScope, type SyncScope } from '../sync/scopeContext';

export interface AiRecipeCollectionOwner {
  verified: true;
  userId: string;
  sessionTokenIdentity: string;
  scope: SyncScope;
}

export const createAiRecipeCollectionOwner = (
  userId: string | null,
  verified: boolean,
  sessionTokenIdentity: string | null,
  scope: SyncScope,
): AiRecipeCollectionOwner | null => (
  userId !== null && verified && sessionTokenIdentity !== null
    ? { verified: true, userId, sessionTokenIdentity, scope }
    : null
);

export const isSameAiRecipeCollectionOwner = (
  left: AiRecipeCollectionOwner | null | undefined,
  right: AiRecipeCollectionOwner | null | undefined,
): boolean => left !== null && left !== undefined
  && right !== null && right !== undefined
  && left.verified === right.verified
  && left.userId === right.userId
  && left.sessionTokenIdentity === right.sessionTokenIdentity
  && left.scope === right.scope;

export const isCurrentAiRecipeCollectionOwner = (owner: AiRecipeCollectionOwner): boolean => {
  if (!owner.verified) return false;
  const { user, csrfToken } = useAuthStore.getState();
  return user !== null
    && user.id === owner.userId
    && user.emailVerifiedAt.trim().length > 0
    && csrfToken !== null
    && csrfToken === owner.sessionTokenIdentity
    && getActiveDataScope() === owner.scope;
};
