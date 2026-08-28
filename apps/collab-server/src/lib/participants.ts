import { Prisma, prisma } from "@devcolab/database";

/**
 * Enrol a user in a session, tolerating a concurrent enrolment of the same
 * pair.
 *
 * `upsert` is not atomic against a competing insert: both callers see no row,
 * both INSERT, and the loser gets P2002 on the (session_id, user_id) unique
 * index. That is routine here — opening a session fires an HTTP GET while the
 * browser's socket sends `session:join`, so the two race on every page load.
 *
 * A duplicate means the row already exists, which is exactly the state the
 * caller wanted, so it is success rather than an error. Anything else is a
 * real failure and still throws.
 */
export async function enrollParticipant(sessionId: string, userId: string): Promise<void> {
  try {
    await prisma.sessionParticipant.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      update: { leftAt: null },
      create: { sessionId, userId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the race; the other caller created the row. Clear leftAt so a
      // rejoin after leaving still marks the user present.
      await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId },
        data: { leftAt: null },
      });
      return;
    }
    throw err;
  }
}
