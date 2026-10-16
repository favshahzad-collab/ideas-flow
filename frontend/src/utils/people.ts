/** The one fact the eyebrow needs off each person. */
export interface CountablePerson {
  twoFactorEnabled?: boolean
}

/**
 * The line above "People & delegation".
 *
 * It counts people, and one thing about them: how many sign in on a password
 * alone. That belongs here rather than beside the departments figure in the
 * sidebar - people are this header's to count, departments are the card's -
 * which is the rule that stopped this screen reading "1 person · 1
 * department" while the card beside it said 37.
 *
 * The two-step figure appears only when it is not zero. A line that reads "0
 * without two-step" every day is a line an administrator learns to skim, and
 * then it is furniture on the morning it reads 3. Absent means nothing to
 * report; present means somebody to talk to.
 */
export function peopleEyebrow(people: CountablePerson[], loading: boolean): string {
  if (loading) return 'People & delegation'

  const count = `${people.length} ${people.length === 1 ? 'person' : 'people'}`
  const withoutTwoStep = people.filter(person => !person.twoFactorEnabled).length

  return withoutTwoStep > 0 ? `${count} · ${withoutTwoStep} without two-step` : count
}
