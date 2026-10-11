"use client";

import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { acceptInviteAction } from "./actions";

export function AcceptInvite({ token }: { token: string }) {
  return (
    <ActionForm action={acceptInviteAction} refresh={false}>
      {({ pending }) => (
        <>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" variant="primary" loading={pending}>Accept invitation</Button>
        </>
      )}
    </ActionForm>
  );
}
