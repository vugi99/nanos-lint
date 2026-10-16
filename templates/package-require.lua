local fs = require "bee.filesystem"
local furi = require "file-uri"

function ResolveRequire(_, name, sourceUri)
  if type(name) ~= "string" or type(sourceUri) ~= "string" then
    return nil
  end

  local sourcePath = fs.path(furi.decode(sourceUri))
  local candidate = sourcePath:parent_path() / name:gsub("\\", "/")
  if fs.exists(candidate) and not fs.is_directory(candidate) then
    return { furi.encode(candidate:string()) }
  end

  return nil
end
