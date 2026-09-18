/**
 * Who is asking.
 *
 * On Supabase this reads the session from the auth cookie. Locally there is no
 * auth server, so DEMO_USER_ID stands in. The important part is that everything
 * downstream receives a user id and nothing downstream can proceed without one,
 * so wiring real auth in later changes this file and nothing else.
 */
export async function currentUserId(): Promise<string> {
  const demo = process.env.DEMO_USER_ID;
  if (demo) return demo;
  throw new Error('No signed-in user. Set DEMO_USER_ID for local development.');
}
