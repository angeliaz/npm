"use strict"
var semver = require("semver")
var asyncMap = require("slide").asyncMap
var path = require("path")
var union = require("lodash.union")
var iferr = require("iferr")
var fetchPackageMetadata = require("../fetch-package-metadata.js")
var addParentToErrors = require("./add-parent-to-errors.js")
var inflateShrinkwrap = require("./inflate-shrinkwrap.js")

// The export functions in this module mutate a dependency tree, adding
// items to them.


// Add a list of args to tree's top level dependencies
exports.loadRequestedDeps = function (args, tree, saveToDependencies, log, cb) {
  asyncMap( args, function (spec, amcb) {
    addDependency(spec, tree, log.newGroup("loadArgs"), iferr(cb, function (child, log) {
      child.directlyRequested = true
      child.save = saveToDependencies
      loadDeps(child, log, cb)
    }))
  }, cb)
}

// Load any missing dependencies in the given tree
exports.loadDeps = loadDeps
function loadDeps (tree, log, cb) {
  if (tree.loaded) return cb()
  tree.loaded = true
  if (!tree.package.dependencies) tree.package.dependencies = {}
  asyncMap(Object.keys(tree.package.dependencies), function (dep, amcb) {
    var version = tree.package.dependencies[dep]
    if (   tree.package.optionalDependencies
        && tree.package.optionalDependencies[dep]) {
      amcb = warnOnError(log, amcb)
    }
    var spec = dep + "@" + version
    addDependency(spec, tree, log.newGroup("loadDep:"+dep), iferr(cb, function (child, log) {
      loadDeps(child, log, amcb)
    }))
  }, cb)
}

// Load development dependencies into the given tree
exports.loadDevDeps = function (tree, log, cb) {
  if (!tree.package.devDependencies) return cb()
  asyncMap(Object.keys(tree.package.devDependencies), function (dep, amcb) {
    // things defined as both dev dependencies and regular dependencies are treated
    // as the former
    if (tree.package.dependencies[dep]) return amcb()

    var spec = dep + "@" + tree.package.devDependencies[dep]
    var logGroup = log.newGroup("loadDevDep:"+dep)
    addDependency(spec, tree, logGroup, iferr(amcb, function (child, tracker) {
      child.devDependency = true
      loadDeps(child, tracker, amcb)
    }))
  }, cb)
}

function warnOnError (log, cb) {
  return function (er, result) {
    if (er) {
      log.warn("install", "Couldn't install optional dependency:", er.message)
      log.verbose("install", er.stack)
    }
    cb(null, result)
  }
}


function replaceDependency (spec, tree, log, cb) {
  cb = addParentToErrors(tree, cb)
  fetchPackageMetadata(spec, tree.path, log.newItem("fetchMetadata"), iferr(cb, function (pkg) {
    resolveRequirement(pkg, tree, log, cb)
  }))
}

function addDependency (spec, tree, log, cb) {
  cb = addParentToErrors(tree, cb)
  fetchPackageMetadata(spec, tree.path, log.newItem("fetchMetadata"), iferr(cb, function (pkg) {
    var version = pkg.requested && pkg.requested.spec
                ? pkg.requested.spec
                : pkg.version
    var child = findRequirement(tree, pkg.name, version)
    if (child) {
      resolveWithExistingModule(child, pkg, tree, log, cb)
    }
    else {
      resolveRequirement(pkg, tree, log, cb)
    }
  }))
}

function resolveWithExistingModule (child, pkg, tree, log, cb) {
  if (!child.package.requested) {
    if (semver.satisfies(child.package.version, pkg.requested.spec)) {
      child.package.requested = pkg.requested
    }
    else {
      child.package.requested =
        { spec: child.package.version
        , type: "version"
        }
    }
  }
  if (child.package.requested.spec !== pkg.requested.spec) {
    child.package.requested.spec += " " + pkg.requested.spec
    child.package.requested.type = "range"
  }
  child.requiredBy = union(child.requiredBy || [], [tree])
  tree.requires = union(tree.requires || [], [child])

  if (! child.loaded && pkg.shrinkwrap && pkg.shrinkwrap.dependencies) {
    return inflateShrinkwrap(child, pkg.shrinkwrap.dependencies, cb)
  }
  return cb(null, child, log)
}

function pushUnique (obj, key, element) {
  if (!obj[key]) obj[key] = []
  if (obj[key].filter(function (value){ return value === element}).length===0) {
    obj[key].push(element)
  }
}

function resolveRequirement (pkg, tree, log, cb) {
  var child = {
    package:    pkg,
    children:   [],
    requiredBy: [tree],
    requires:   []
    }

  child.parent = earliestInstallable(tree, pkg.name) || tree
  child.parent.children.push(child)

  tree.requires = union(tree.requires || [], [child])

  pushUnique(tree, "requires", child)

  child.path = path.join(child.parent.path, "node_modules", pkg.name)
  child.realpath = path.resolve(child.parent.realpath, "node_modules", pkg.name)

  if (pkg.shrinkwrap && pkg.shrinkwrap.dependencies) {
    return inflateShrinkwrap(child, pkg.shrinkwrap.dependencies, cb)
  }

  cb(null, child, log)
}

// Determine if a module requirement is already met by the tree at or above
// our current location in the tree.
function findRequirement (tree, name, version) {
  var nameMatch = function (child) {
    return child.package.name === name
  }
  var versionMatch = function (child) {
    return semver.satisfies(child.package.version, version)
  }
  if (nameMatch(tree)) {
    // this *is* the module, but it doesn't match the version, so a
    // new copy will have to be installed
    return versionMatch(tree) ? tree : null
  }
  var matches = tree.children.filter(nameMatch)
  if (matches.length) {
    matches = matches.filter(versionMatch)
    // the module exists as a dependent, but the version doesn't match, so
    // a new copy will have to be installed above here
    if (matches.length) return matches[0]
    return null
  }
  if (!tree.parent) return null
  return findRequirement(tree.parent, name, version)
}

// Find the highest level in the tree that we can install this module in.
// If the module isn't installed above us yet, that'd be the very top.
// If it is, then it's the level below where its installed.
function earliestInstallable (tree, name) {
  var nameMatch = function (child) {
    return child.package.name === name
  }
  if (nameMatch(tree)) return tree
  var matches = tree.children.filter(nameMatch)
  if (matches.length) return null
  if (!tree.parent) return tree
  return (earliestInstallable(tree.parent, name) || tree)
}
