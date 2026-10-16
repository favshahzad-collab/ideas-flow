import { ACCESS_SELECT, capabilitiesOf } from "../lib/capabilities";
import { prisma } from "../prisma";
import { delegationsService } from "./delegations.service";

/**
 * Who is asking, as the read rules need them.
 *
 * Two facts, and every read path needs both: the ids whose steps count as
 * this person's, and whether they are an administrator. They are read
 * together because neither is worth a round trip of its own and one of them
 * is already happening.
 */
export type Viewer = {
  userId: string;
  /** People who have delegated their approvals to this person. */
  actingFor: readonly string[];
  /**
   * The same, with the kinds of memo each cover is limited to - for deciding
   * whether a memo is waiting on this person, where a scoped cover counts
   * only for its own kinds of memo. Reading is not narrowed by it.
   */
  cover: readonly { delegatorId: string; memoTypes: readonly string[] }[];
  /**
   * Administrators read every memo in the organisation.
   *
   * Not a shortcut around the participant rule - a different rule, and the
   * one an approval system has to have. Everybody else sees a memo because
   * they wrote it or because the workflow reached them; an administrator sees
   * it because answering for the process means being able to look at any of
   * it. Without this the person who runs the system is the one person who
   * cannot open a memo after it is approved: the oversight screen shows only
   * what is still in flight, so an approved memo used to become invisible to
   * them the moment it finished.
   *
   * Reading only. Preparing, editing, approving and deleting are unchanged -
   * an administrator has no step on somebody else's chain and cannot sign for
   * them.
   */
  isAdministrator: boolean;
};

export async function viewerFor(userId: string): Promise<Viewer> {
  const [cover, account] = await Promise.all([
    delegationsService.coverHeldBy(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: ACCESS_SELECT,
    }),
  ]);

  return {
    userId,
    actingFor: [...new Set(cover.map((held) => held.delegatorId))],
    cover,
    // Every memo is readable to whoever holds that power: every Super
    // Administrator, and an administrator only if they were given it.
    isAdministrator: account ? capabilitiesOf(account).includes("memos.view.all") : false,
  };
}
