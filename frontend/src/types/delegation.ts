/** The two ends of a delegation, as the API returns them. */
export type DelegationPerson = {
  id: string
  firstName: string
  lastName: string
  designation: string | null
  email: string
}

export type Delegation = {
  id: string
  delegatorId: string
  delegateId: string
  startsAt: string
  /** Null means until it is ended by hand. */
  endsAt: string | null
  reason: string | null
  /** The kinds of memo it covers; empty is every memo. Absent from older servers. */
  memoTypes?: string[]
  revokedAt: string | null
  createdAt: string
  delegator: DelegationPerson
  delegate: DelegationPerson
  /**
   * Whether it applies right now. Decided by the server against its own
   * clock, not recomputed here: two clocks disagreeing about whether somebody
   * may sign is worse than one clock being slightly wrong.
   */
  isActive: boolean
}

export type DelegationLists = {
  /** Delegations this person has given away. */
  given: Delegation[]
  /** Delegations this person holds for somebody else. */
  held: Delegation[]
}
