import test from "node:test"
import assert from "node:assert/strict"
import { sum } from "../src/sum.js"

test("sum adds every number", () => {
  assert.equal(sum([1, 2, 3, 4]), 10)
})

test("sum handles an empty list", () => {
  assert.equal(sum([]), 0)
})

test("sum handles a single number", () => {
  assert.equal(sum([7]), 7)
})
