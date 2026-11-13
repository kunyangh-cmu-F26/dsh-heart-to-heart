// Normalize a narrow set of explicitly stated conversation preferences.
// Tool arguments are controlled phrases, so story details and names cannot become memory.
const optOut = /别(?:把.{0,18})?(?:记|存)|不(?:要|用)(?:把.{0,18})?(?:记|存)|不想被记|只在这聊|保密|don['’]t (?:save|store|remember)|do not (?:save|store|remember)|keep (?:this|it) between us/iu
const firstPerson = /(?:我(?:希望|喜欢|更喜欢|习惯|比较希望|需要)|我难受时|我难过时|以后(?:我|你|请)|下次(?:我|你|请)|每次我|i (?:prefer|like|want|need)|in the future|next time|when i (?:vent|am upset))/iu

const preferences = [
  {
    cue: /(?:先听我(?:说|讲)完|让我(?:说|讲)完|别(?:急着|太快)打断|let me finish|hear me out|listen (?:to me )?first)/iu,
    text: '用户倾诉时，希望先把话说完，再听对方展开回应。',
  },
  {
    cue: /(?:先问我.{0,10}(?:建议|意见)|(?:我问|我开口).{0,8}(?:才|再).{0,6}(?:建议|意见)|别(?:急着|直接)(?:给|提)(?:建议|意见)|ask (?:me )?before (?:giving|offering) advice|only give advice when i ask)/iu,
    text: '用户倾诉时，希望给建议前先问问自己想不想听。',
  },
  {
    cue: /(?:先(?:接住|理解|聊聊|回应)我的(?:感受|情绪)|先安慰我|validate my feelings first|acknowledge (?:my feelings|how i feel) first)/iu,
    text: '用户倾诉时，希望对方先回应自己的感受。',
  },
  {
    cue: /(?:只问一个问题|一次只问一个|one question at a time)/iu,
    text: '用户倾诉时，希望对方一次只问一个问题。',
  },
]

export function extractPreferences(text) {
  if (optOut.test(text)) return { blocked: true, items: [] }
  const clauses = text.split(/[\n。！？!?]/u)
  const items = preferences
    .filter(({ cue }) => clauses.some(clause => firstPerson.test(clause) && cue.test(clause)
      && !/(?:别的?人|他说|她说|你说过|如果.{0,12}的话|我以前|不再|不希望|不喜欢|不需要|不是说|used to|i don['’]t|i do not|i no longer)/iu.test(clause)))
    .map(({ text: content }) => ({ kind: 'preference', content }))
  return { blocked: false, items }
}
