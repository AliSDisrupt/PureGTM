import { NextRequest, NextResponse } from "next/server";

function resolveAppBaseUrl(request: NextRequest): string {
  const configuredBase = String(process.env.APP_BASE_URL ?? "").trim();
  if (configuredBase) {
    return configuredBase.replace(/\/+$/, "");
  }
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost && !forwardedHost.includes(".railway.internal")) {
    return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, "");
  }
  if (!request.nextUrl.host.includes(".railway.internal")) {
    return request.nextUrl.origin;
  }
  return "https://gtmpurewl.up.railway.app";
}

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", `${resolveAppBaseUrl(request)}/`));
  response.cookies.set("purewl_auth", "", { path: "/", maxAge: 0 });
  response.cookies.set("purewl_auth_name", "", { path: "/", maxAge: 0 });
  response.cookies.set("purewl_auth_email", "", { path: "/", maxAge: 0 });
  response.cookies.set("purewl_auth_picture", "", { path: "/", maxAge: 0 });
  response.cookies.set("purewl_google_oauth_state", "", { path: "/", maxAge: 0 });
  return response;
}
