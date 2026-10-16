/**
 * The part of `nspell` the memo editor uses. Declared here rather than
 * taken from `@types/nspell`, which references Node's types and this app
 * runs in a browser.
 */
declare module 'nspell' {
  interface NSpell {
    /** Whether the word is in the dictionary, affixes and case rules applied. */
    correct(word: string): boolean
    /** Words the dictionary knows that are close to this one. */
    suggest(word: string): string[]
    /** Teach the dictionary a word, for this session. */
    add(word: string): NSpell
  }

  function nspell(aff: string, dic: string): NSpell

  export default nspell
}
