# Changelog

## 0.2.0

`instructions` on `dubs.create()` and `dub()`: notes for the dub, followed on paid plans.

`dubs.quality()` returns Reedapt's check of a finished dub, and webhooks gain the `dub.checked` event.

Early access: `dubs.requests.create()`, `runs.retrieve()` and `runs.answer()` to ask Reedapt for changes, and `dubs.lines.list()` and `dubs.lines.edit()` to read and edit lines.

## 0.1.0

`dubs.transcript()`, `dubs.subtitles()` (SRT or WebVTT) and `webhookEndpoints.resendDelivery()`.

`usage.report()` for a month of minutes and dubs per key and per language.

First release: uploads in parts and from links, dubs, languages, usage, webhook endpoints, webhook signature checks, retries and idempotency keys.
