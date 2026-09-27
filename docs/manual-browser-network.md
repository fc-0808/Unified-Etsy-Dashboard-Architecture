# Manual Etsy browser network runbook

This runbook covers reliable connectivity for a manually operated browser profile.

The AdsPower MCP, agent Skill, and global CLI are intentionally not installed
for this workflow. They can start browsers, retrieve cookies, and modify proxy or
fingerprint settings; the single read-only Local API endpoint below provides all
information this audit needs with substantially less privilege.

## Supported path

For a manually operated AdsPower profile:

```text
AdsPower browser → its saved IPFoxy static proxy → Etsy
                       TCP carried by Efan's Windows TUN route
```

For dashboard Open API requests:

```text
Dashboard → Efan loopback SOCKS5 → mandatory IPFoxy SOCKS5 → Etsy Open API
```

Efan's **Proxy port 7897** is a verified SOCKS5 listener and is used explicitly
by UED. Keep `network_transport.mode` set to `local_socks5`, keep **Allow LAN
access** disabled, and leave the listener bound to loopback.

## One-time setup

1. In Efan, connect the intended node, keep proxy port `7897`, enable TUN for
   applications that need system-level routing, and keep **Allow LAN access**
   disabled.
2. In AdsPower, assign the existing IPFoxy dedicated static proxy to each
   authorized, manually operated profile. Do not select **No Proxy** or an
   automatic/rotating proxy when the intended assignment is static.
3. Use AdsPower's built-in **Check Proxy** action and retain the expected static
   address in the corresponding config group's `expected_egress_ip`.
4. Record the AdsPower `profile_id` as `adspower_profile_id` at shop level, or at
   group level only when every shop in that group intentionally uses the same
   profile.
5. Declare every static browser profile and its provider-confirmed public exit
   without storing proxy credentials:

   ```json
   {
     "browser_expected_static_proxy_count": 3,
     "browser_profiles": [
       {
         "profile_id": "PROFILE_ID",
         "expected_egress_ip": "203.0.113.10",
         "label": "AdsPower profile"
       }
     ]
   }
   ```

   A declared profile may be audit-only when the dashboard never launches or
   selects it. Dashboard group mappings are checked separately.
6. Copy the AdsPower Local API key from **Automation → API** into the gitignored
   `.env` file:

   ```text
   ADSPOWER_API_KEY=<local API key>
   ADSPOWER_LOCAL_API_URL=http://127.0.0.1:<port shown by AdsPower>
   ```

The API key is sent only to a validated loopback URL. The audit calls only
`POST /api/v2/browser-profile/list`; it never starts a profile, reads cookies,
or changes browser/proxy settings.

AdsPower may listen on all network interfaces even when its UI displays
`127.0.0.1`. From an Administrator PowerShell, install the repository's
reversible inbound block:

```powershell
npm run browser:secure-api
```

The script reads the current port from `.env`, keeping loopback access working
while blocking that port from LAN, VPN, and other remote interfaces. Remove it
only for a deliberate external API use with `npm run browser:unsecure-api`.

## Before manual seller access

Run:

```powershell
npm run browser:verify
```

Proceed only when:

- Efan and every configured IPFoxy route pass.
- The expected number of static browser mappings is present.
- Every AdsPower profile exists and is not configured as no-proxy or rotating.
- Its last checked exit matches the configured static address.

Then open the profile yourself, use AdsPower **Check Proxy** once more if its
last-known address is absent, navigate to Etsy manually, and complete any Etsy
security or two-factor challenge normally. Do not automate sign-in or retry
security challenges programmatically.

## Official references

- [AdsPower IPFoxy setup](https://help.adspower.com/docs/ipfoxy)
- [AdsPower proxy types and Check Proxy](https://help.adspower.com/docs/proxy_types)
- [AdsPower Local API profile query](https://localapi-doc-en.adspower.com/docs/Query-Profile-V2)
