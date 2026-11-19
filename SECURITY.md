# Security

## Reporting a vulnerability

Please do not open a public issue. Email security@vojo-media.com with the version you use and the steps to reproduce it. We will reply as soon as we can, and tell you when it is fixed.

## Keeping your key safe

- A secret key belongs on your server, in a secrets manager or environment variable. Never put one in a browser, a player or a creative.
- This library never includes your key in errors or in a printed client. Please report it if you ever see otherwise.
- Always verify webhooks with `webhooks.constructEvent` before you trust them.
