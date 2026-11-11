-- Ordinary source: the first directive is a class, so this file is not exported.
---@class NotExported
NotExported = {}

function UsesNotExported()
  return NotExported
end
