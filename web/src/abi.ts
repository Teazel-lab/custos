export const hubAbi = [
  {
    type: 'function',
    name: 'activate',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isProtected',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

export const registryAbi = [
  {
    type: 'function',
    name: 'report',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'reason', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'hasReported',
    stateMutability: 'view',
    inputs: [
      { name: 'reporter', type: 'address' },
      { name: 'target', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export const agentIdAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'handleOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'string' }],
  },
] as const
