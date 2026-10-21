/**
 * Example: dedupe_check on_select, rewritten to the L2 standard.
 * Same checks as the original 16 hand-written if/return blocks.
 */
function validate(targetPayload, sessionData) {
  return runChecks([
    { id: 'S02', desc: 'context.action must be on_select', path: '$.context.action', rule: { eq: 'on_select' } },
    { id: 'S03', desc: 'transaction_id must match the session', path: '$.context.transaction_id',
      rule: { eqSession: 'transactionId[0]' }, when: { session: 'transactionId[0]' } },
    { id: 'O04', desc: 'provider.id is required', path: '$.message.order.provider.id', rule: 'required' },
    { id: 'O05', desc: 'order.items must be a non-empty list', path: '$.message.order.items', rule: 'nonEmpty' },
    { id: 'O10', desc: 'order.fulfillments must be a non-empty list', path: '$.message.order.fulfillments', rule: 'nonEmpty' },
    { id: 'S06', desc: 'every item id must exist in the on_search catalog', path: '$.message.order.items[*].id',
      rule: { existsIn: 'session:item_ids' }, when: { session: 'item_ids' } },
    { id: 'BL_SEL_01', desc: 'loan items need a LOAN_INFO tag', path: '$.message.order.items[*].tags[*].descriptor.code',
      rule: { contains: 'LOAN_INFO' }, when: { path: '$.message.order.items[*].category_ids', includes: 'LOAN' } },
    { id: 'BL_SEL_02', desc: 'offer amount must not exceed the sanctioned limit',
      reads: ['$.message.order.quote.price.value', 'session:sanction_limit'],
      custom: (p, s) => !s.sanction_limit || Number(p.message.order.quote.price.value) <= Number(s.sanction_limit) },
  ], targetPayload, sessionData);
}
