import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { DomainError } from "@editagent/domain";
import {
  AuthRateLimitedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "../application/authentication.js";
import {
  clearSessionCookies,
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfMatches,
  readCookie,
  REFRESH_COOKIE,
  sessionCookies,
} from "./auth-cookies.js";

class CredentialsBody {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password!: string;
}

interface HeaderRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface CookieReply {
  append(name: string, value: string): void;
  setHeader(name: string, value: string | readonly string[]): void;
}

export const AUTH_NOW = "AUTH_NOW";
export const AUTH_COOKIE_SECURE = "AUTH_COOKIE_SECURE";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUser,
    private readonly loginUser: LoginUser,
    private readonly refreshAccess: RefreshAccess,
    private readonly logoutUser: LogoutUser,
    @Inject(AUTH_NOW) private readonly now: () => bigint,
    @Inject(AUTH_COOKIE_SECURE) private readonly cookieSecure: boolean,
  ) {}

  @Post("register")
  @HttpCode(201)
  @ApiOperation({ summary: "Register and start a session." })
  @ApiCreatedResponse({ description: "The account exists and session cookies were set." })
  @ApiBadRequestResponse({ description: "The email or password failed validation." })
  @ApiUnauthorizedResponse({ description: "The password was rejected." })
  @ApiConflictResponse({ description: "The email is already registered." })
  @ApiTooManyRequestsResponse({ description: "Too many attempts from this client." })
  async register(
    @Body() body: CredentialsBody,
    @Req() request: HeaderRequest,
    @Res({ passthrough: true }) response: CookieReply,
  ): Promise<{ id: string; email: string }> {
    try {
      const session = await this.registerUser.execute(
        body.email,
        body.password,
        clientKey(request),
      );
      writeCookies(response, sessionCookies(session, this.now(), this.cookieSecure));
      return { id: session.userId, email: session.email };
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "Sign in and start a session." })
  @ApiOkResponse({ description: "Session cookies were set." })
  @ApiBadRequestResponse({ description: "The email or password failed validation." })
  @ApiUnauthorizedResponse({ description: "Email or password is incorrect." })
  @ApiTooManyRequestsResponse({ description: "Too many attempts from this client." })
  async login(
    @Body() body: CredentialsBody,
    @Req() request: HeaderRequest,
    @Res({ passthrough: true }) response: CookieReply,
  ): Promise<{ id: string; email: string }> {
    try {
      const session = await this.loginUser.execute(body.email, body.password, clientKey(request));
      writeCookies(response, sessionCookies(session, this.now(), this.cookieSecure));
      return { id: session.userId, email: session.email };
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "Rotate the refresh token and issue a new access token." })
  @ApiOkResponse({ description: "The session was rotated." })
  @ApiUnauthorizedResponse({
    description: "The refresh token is missing, expired, or already used.",
  })
  @ApiForbiddenResponse({ description: "The CSRF token does not match the cookie." })
  async refresh(
    @Req() request: HeaderRequest,
    @Res({ passthrough: true }) response: CookieReply,
  ): Promise<{ id: string; email: string }> {
    requireCsrf(request);
    const refreshToken = readCookie(headerValue(request.headers?.cookie), REFRESH_COOKIE);
    if (refreshToken === undefined) {
      throw new UnauthorizedException("Sign in is required.");
    }
    try {
      const session = await this.refreshAccess.execute(refreshToken);
      writeCookies(response, sessionCookies(session, this.now(), this.cookieSecure));
      return { id: session.userId, email: session.email };
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke the refresh session and clear cookies." })
  @ApiNoContentResponse({
    description: "The refresh session was revoked and the cookies were cleared.",
  })
  @ApiUnauthorizedResponse({ description: "The CSRF token does not match the cookie." })
  @ApiForbiddenResponse({ description: "The CSRF token does not match the cookie." })
  async logout(
    @Req() request: HeaderRequest,
    @Res({ passthrough: true }) response: CookieReply,
  ): Promise<void> {
    requireCsrf(request);
    const refreshToken = readCookie(headerValue(request.headers?.cookie), REFRESH_COOKIE);
    try {
      await this.logoutUser.execute(refreshToken);
    } catch {
      // An already revoked or malformed token still ends the browser session.
    }
    writeCookies(response, clearSessionCookies(this.cookieSecure));
  }
}

function requireCsrf(request: HeaderRequest): void {
  const cookie = readCookie(headerValue(request.headers?.cookie), CSRF_COOKIE);
  const header = headerValue(request.headers?.[CSRF_HEADER]);
  if (!csrfMatches(header, cookie)) {
    throw new UnauthorizedException("Sign in is required.");
  }
}

function writeCookies(response: CookieReply, cookies: readonly string[]): void {
  response.setHeader("Set-Cookie", cookies);
}

function clientKey(request: HeaderRequest): string {
  return request.socket?.remoteAddress ?? request.ip ?? "unknown";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mapAuthError(error: unknown): Error {
  if (error instanceof EmailAlreadyRegisteredError) {
    return new ConflictException(error.message);
  }
  if (error instanceof AuthRateLimitedError) {
    return new HttpException(error.message, 429);
  }
  if (error instanceof InvalidCredentialsError || error instanceof DomainError) {
    return new UnauthorizedException(
      error instanceof InvalidCredentialsError ? error.message : "Sign in is required.",
    );
  }
  return error instanceof Error ? error : new UnauthorizedException("Sign in is required.");
}
