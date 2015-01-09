"use strict"
var finishLogAfterCb = require("./finish-log-after-cb.js")
var flattenTree = require("./flatten-tree.js")

function pkgAreEquiv (aa, bb) {
  if (aa.dist && bb.dist && aa.dist.shasum === bb.dist.shasum) return true
  if (aa.dist || bb.dist) return false
  if (aa.version === bb.version) return true
}

module.exports = function (oldTree, newTree, differences, log, cb) {
  cb = finishLogAfterCb(log.newItem(log.name), cb)
  oldTree = flattenTree(oldTree)
  newTree = flattenTree(newTree)
  Object.keys(oldTree).forEach(function (path) {
    if (newTree[path]) return
    differences.push(["remove", oldTree[path]])
  })
  Object.keys(newTree).forEach(function (path) {
    if (oldTree[path]) {
      if (!newTree[path].directlyRequested && pkgAreEquiv(oldTree[path].package, newTree[path].package)) return
      differences.push(["update", newTree[path]])
    }
    else {
      differences.push(["add", newTree[path]])
    }
  })
  cb()
}
