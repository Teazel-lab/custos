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
  'No trace or simulate result, so token movements were not decoded.'
export const REVERTED = 'Simulation reverted.'
export const NESTED_REVERT = 'An inner call reverted and was caught by the transaction.'
export const UNKNOWN_CALLDATA =
  'Calldata selector was not recognized, and call mode cannot see its effects.'
export const VALUE_UNSIMULATED = 'Native value was not simulated. Call mode cannot see where it goes.'
export const UNSUPPORTED_TESTNET =
  'Honeypot.is and GoPlus do not cover this testnet. Those checks were skipped.'
export const REGISTRY_BASE =
  'The Custos registry and Agent ID are on BNB Chain. This Base check does not use them.'

/** Added to the explanation only when the check's `complete` field is false. */
export const INCOMPLETE_NOTE = 'This check is incomplete.'

/**
 * Names the provider that missed. It does not say the check is incomplete:
 * another provider may already have covered the transaction, and only
 * `complete: false` means the check is incomplete.
 */
export function providerReason(name: string, detail?: string): Reason {
  const cause = detail ? ` (${publicCause(name, detail)})` : ''
  return {
    code: 'provider_failed',
    severity: 'info',
    message: `${name} did not answer${cause}; other providers were used where possible.`,
  }
}

function publicCause(name: string, detail: string): string {
  const prefix = `${name} `
  return detail.startsWith(prefix) ? detail.slice(prefix.length) : detail
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

export function eoaDelegated(address: string): Reason {
  return {
    code: 'eoa_delegated',
    severity: 'warn',
    message: `Address ${address} is an EOA with delegated code.`,
  }
}

export function valueToContract(to: string): Reason {
  return {
    code: 'value_to_unverified',
    severity: 'warn',
    message: `Value leaves the sender toward contract ${to}. This check did not verify that contract.`,
  }
}
