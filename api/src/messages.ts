import type { Reason } from './types'

export const WALLET_SENTENCE =
  'This check does not sign or send the transaction. Confirm it in your own wallet.'

export const UNLIMITED = 'Unlimited token allowance.'
export const APPROVAL = 'Token allowance granted to a spender.'
export const APPROVAL_FOR_ALL = 'Operator approval for an entire collection.'
export const PERMIT = 'Permit signature that can grant an allowance.'
export const PERMIT2 = 'Permit2 can grant a spender the right to pull tokens.'
export const TRANSFER_FROM = 'transferFrom can pull tokens the caller is allowed to move.'
export const TRACE_UNAVAILABLE =
  'Trace provider did not answer. Simulation used eth_call only, so token movements were not decoded.'

export function providerReason(name: string): Reason {
  return {
    code: 'provider_failed',
    severity: 'warn',
    message: `${name} did not answer. Treat this check as incomplete.`,
  }
}

export function approvalToEoa(spender: string): Reason {
  return {
    code: 'approval_to_eoa',
    severity: 'danger',
    message: `Approval spender ${spender} is an EOA (no contract code).`,
  }
}

export function valueToEoa(to: string): Reason {
  return {
    code: 'value_to_eoa',
    severity: 'warn',
    message: `Value leaves the sender toward EOA ${to}.`,
  }
}

export function valueToContract(to: string): Reason {
  return {
    code: 'value_to_unverified',
    severity: 'warn',
    message: `Value leaves the sender toward contract ${to}. This check did not verify that contract.`,
  }
}
