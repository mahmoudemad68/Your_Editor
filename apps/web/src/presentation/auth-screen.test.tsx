import "./dom-setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthScreen } from "./auth-screen";
import { SessionClient } from "./session-client";

afterEach(cleanup);

test("malformed credentials have accessible field errors and do not submit", async () => {
  let calls = 0;
  const client = new SessionClient(async () => {
    calls++;
    return Response.json({});
  });
  render(<AuthScreen mode="register" client={client} navigate={() => {}} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b..com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
  assert.equal(screen.getAllByRole("alert").length, 2);
  assert.equal(screen.getByLabelText("Email").getAttribute("aria-invalid"), "true");
  assert.equal(document.activeElement, screen.getByLabelText("Email"));
  assert.equal(calls, 0);
  assert.equal(screen.getByLabelText("Password").getAttribute("autocomplete"), "new-password");
});

test("submit state and generic error are accessible with password-manager attributes", async () => {
  let finish!: (response: Response) => void;
  const client = new SessionClient(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  render(<AuthScreen mode="login" client={client} navigate={() => {}} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "wrong-password-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  assert.equal(screen.getByRole("button", { name: "Please wait…" }).hasAttribute("disabled"), true);
  finish(Response.json({ message: "secret detail" }, { status: 401 }));
  await waitFor(() =>
    assert.equal(screen.getByRole("alert").textContent, "Email or password is incorrect."),
  );
  assert.equal(screen.getByLabelText("Email").getAttribute("autocomplete"), "username");
  assert.equal(screen.getByLabelText("Password").getAttribute("autocomplete"), "current-password");
});
