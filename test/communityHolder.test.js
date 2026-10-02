// Run: QR_SECRET_KEY=x node --test test/communityHolder.test.js
process.env.QR_SECRET_KEY = process.env.QR_SECRET_KEY || "throwaway-test-secret-key";
const test = require("node:test");
const assert = require("node:assert");
const { communityHolderLabel } = require("../src/services/thirdPartyService");

test("holder sent to the community app is always one of donor/sponsor/patron/invitational", () => {
  assert.strictEqual(communityHolderLabel("INV", "Invitee"), "Invitational");
  assert.strictEqual(communityHolderLabel("INV", "invitees"), "Invitational");
  assert.strictEqual(communityHolderLabel("INV", "Special Guest"), "Invitational"); // renamed type, code decides
  assert.strictEqual(communityHolderLabel("SP", "Sponsor"), "Sponsor");
  assert.strictEqual(communityHolderLabel("DN", "Donor"), "Donor");
  assert.strictEqual(communityHolderLabel("XX", "PATRON"), "Patron");
  assert.strictEqual(communityHolderLabel("XX", "Invitational"), "Invitational");
});
