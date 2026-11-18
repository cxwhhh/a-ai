import { logout } from "../../../../../../packages/application/users/src/auth";


export async function POST(req: Request) {
  return new Response(null, { status: 204, headers: logout(req) });
}
