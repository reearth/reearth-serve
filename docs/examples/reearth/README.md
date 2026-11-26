# Re:Earth deployment values

Serve stays a generic DAM. This page lists the values the Re:Earth deployment sets on top of the defaults.

## Accounts

The Re:Earth deployment takes workspaces, members and decisions from Re:Earth Accounts. In each environment, set `ACCOUNTS_URL` to that environment's accounts API base URL, the origin that serves `/api/users/me`. [`adapters/accounts/README.md`](../../../adapters/accounts/README.md) describes the setting and its startup errors.

Do these shared-environment steps in order, for each environment, before you set `ACCOUNTS_URL`:

1. Add a `serve` policy target to `.github/workflows/build_cerbos_policies.yml` in reearth-cloud, through that repository's own review.
2. Deploy the `serve` policy. Run `build_cerbos_policies.yml` with `app_type=serve` as a dry run and confirm it lists only `serve_*.yaml` files. Then do the real run and redeploy Cerbos with `deploy_cerbos.yml`.
3. Make accounts trust Serve's tokens. Set Serve's issuer and audience in accounts through `REEARTH_AUTH_ISS` and `REEARTH_AUTH_AUD`, or an entry in `REEARTH_AUTH`. The issuer must match the token's `iss` exactly, trailing slash included. Without it every Serve caller gets `401`.
4. Confirm that accounts has `REEARTH_ACCOUNTS_SIGNUP_SECRET` set. Without it, `POST /api/users/signup-oidc` accepts any caller and any `sub`, so anyone could claim the accounts user for a Serve identity before its owner signs up.
5. Confirm with the accounts owners that per-project roles will read `resource_id`. If they choose another name, `RESOURCE_ID_FIELD` in `adapters/accounts/client.ts` changes.
6. Set `ACCOUNTS_URL` in Serve's Worker settings. Accounts mode starts on fresh Serve data, so do this only once the environment's data question is settled.
