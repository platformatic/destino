import { globalIgnores } from 'eslint/config'
import neostandard from 'neostandard'

const eslint = [...neostandard({}), globalIgnores(['dist/', 'deps/', 'tmp/'])]

export default eslint
