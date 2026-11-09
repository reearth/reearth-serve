# Re:Earth deployment

The values the Re:Earth deployment of Serve uses. Serve's defaults and the
main README stay neutral; this page is the one place they are written down.

## Endpoint

The API and the UI run at `https://serve.reearth.land`. Point the CLI at it:

```bash
REEARTH_SERVE_ENDPOINT=https://serve.reearth.land reearth-serve upload ./data.geojson
```

## Site hosts

Site hosts are off (`SITE_HOST_SUFFIX` unset).

`serve.reearth.land` sits on the registrable domain `reearth.land`, so any
suffix under it, such as `.serve.reearth.land`, would be the same site as the
API. Serve refuses to start when `SITE_REGISTRABLE_DOMAIN` is `reearth.land`
and `BASE_URL` is `https://serve.reearth.land` (ADR-014 §8). Turning site
hosts on needs one of:

- a separate registrable domain for sites, with `SITE_HOST_SUFFIX` under it
  and `SITE_REGISTRABLE_DOMAIN` set to it, or
- a Public Suffix List entry for the sites domain, with
  `SITE_DOMAIN_IS_PUBLIC_SUFFIX=true`.

The choice, the domain registration, the wildcard DNS record, the
certificate and the Worker route are operator steps. The neutral recipe is
the site-host comment in `wrangler.toml` and the "Site hosts" paragraph of the
main README.

## Delivery tokens

Whether `DELIVERY_TOKEN_KEYS` is set in production is an operator setting this
repository does not record. Set it with `wrangler secret put
DELIVERY_TOKEN_KEYS`.
